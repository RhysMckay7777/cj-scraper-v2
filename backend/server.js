const express = require('express');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const zlib = require('zlib');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');
const { searchCJProducts, getCJCategories, cancelScrape, generateScrapeId, MAX_OFFSET } = require('./cj-api-scraper');
const { getCategoryIndex, searchCategories, isValidCategoryId, getCategoryById } = require('./category-service');
const { mapSearchToCategories, generateDynamicKeywords, clearCache: clearKeywordCache } = require('./ai-keyword-generator');

// Price Sync Module
const { 
  generatePreview, 
  executeSync, 
  syncSingleProduct, 
  formatPreviewOutput,
  setCJMetafield 
} = require('./price_sync');

// Gemini API Key for dynamic keyword generation
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// ============================================
// DEBUG: Global error handlers to catch crashes
// ============================================
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message);
  console.error('Stack:', err.stack);
  // Don't exit - let Render handle it
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION at:', promise);
  console.error('Reason:', reason);
});

// Memory logging utility
function logMemory(checkpoint) {
  const used = process.memoryUsage();
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2) + 'MB';
  console.log(`[MEMORY:${checkpoint}] Heap: ${mb(used.heapUsed)}/${mb(used.heapTotal)} | RSS: ${mb(used.rss)} | External: ${mb(used.external)}`);
}

// Track active scrape sessions for cancellation
const activeScrapes = new Map();

const app = express();
const PORT = process.env.PORT || 8080;

// CJ API Token (preferred method)
const CJ_API_TOKEN = process.env.CJ_API_TOKEN || '';

// Google Vision API - Support both API Key and Service Account
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || '';
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON || '';

// If service account JSON provided as env var, write to file
if (GOOGLE_CREDENTIALS_JSON) {
  try {
    // Parse and re-stringify to validate JSON and handle escaped characters
    let credentials;
    try {
      credentials = JSON.parse(GOOGLE_CREDENTIALS_JSON);
    } catch (parseErr) {
      // Try replacing escaped newlines first
      const fixedJson = GOOGLE_CREDENTIALS_JSON.replace(/\\n/g, '\n');
      credentials = JSON.parse(fixedJson);
    }

    // Write valid JSON to file
    fs.writeFileSync('./google-credentials.json', JSON.stringify(credentials, null, 2));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = './google-credentials.json';
    console.log('✅ Google Vision credentials loaded from JSON');
  } catch (e) {
    console.error('Failed to parse/write credentials:', e.message);
    console.log('⚠️ Continuing without Google Vision - text filter only');
  }
}

// Initialize Vision API
let visionAuth = null;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS || GOOGLE_CREDENTIALS_JSON) {
  // Use service account
  console.log('Using Google Vision with Service Account');
} else if (GOOGLE_VISION_API_KEY) {
  // Use API key
  console.log('Using Google Vision with API Key');
} else {
  console.warn('⚠️  No Google Vision credentials - image detection disabled');
}

// Middleware
// IMPORTANT: Increase body size limit for large product uploads (286+ products)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// VERY RELAXED text filter - let image detection do the heavy lifting
// Just need AT LEAST ONE search word to match - Vision API will filter out bad matches
function isRelevantProduct(productTitle, searchTerm) {
  const lowerTitle = (productTitle || '').toLowerCase();
  const lowerSearch = (searchTerm || '').toLowerCase();

  // Extract main keywords (words > 2 chars)
  const searchWords = lowerSearch.split(' ').filter(w => w.length > 2);

  // ===== TEXT-BASED REJECT PATTERNS =====
  // If searching for throws/blankets, reject products with "pillow" in title
  const textRejectPatterns = {
    'throw': ['pillow', 'cushion', 'pillowcase', 'cushion cover'],
    'blanket': ['pillow', 'cushion', 'pillowcase'],
    'fur': ['keychain', 'key chain', 'pendant', 'earring'],
  };

  // Check if title contains reject terms for this search
  for (const [searchKey, rejectTerms] of Object.entries(textRejectPatterns)) {
    if (lowerSearch.includes(searchKey)) {
      // Check if any reject term is in the title WITHOUT the search term nearby
      for (const reject of rejectTerms) {
        if (lowerTitle.includes(reject)) {
          // Special case: "throw pillow" is explicitly a pillow, not a throw blanket
          if (lowerTitle.includes('throw pillow') || lowerTitle.includes('throw pillows')) {
            console.log(`[Text Filter] ❌ Rejected "${productTitle.substring(0, 50)}..." - contains "throw pillow"`);
            return false;
          }
          // If title has pillow but NOT blanket/throw (as a blanket), reject
          if (!lowerTitle.includes('blanket') && !lowerTitle.includes('throw blanket')) {
            console.log(`[Text Filter] ❌ Rejected "${productTitle.substring(0, 50)}..." - contains "${reject}"`);
            return false;
          }
        }
      }
    }
  }

  // VERY RELAXED: At least ONE search word should be present
  // Image detection will catch false positives
  const matchingWords = searchWords.filter(word => lowerTitle.includes(word));

  // Pass if any word matches
  return matchingWords.length >= 1;
}

// Parse CJ URL
function parseCJUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const match = pathname.match(/\/search\/(.+?)\.html/);
    const keyword = match ? decodeURIComponent(match[1]).replace(/\+/g, ' ') : '';
    const params = new URLSearchParams(urlObj.search);
    const filters = {};
    for (const [key, value] of params.entries()) {
      filters[key] = value;
    }
    console.log('Parsed URL:', { keyword, filters });
    return { keyword, filters };
  } catch (e) {
    console.error('URL parse error:', e);
    return { keyword: '', filters: {} };
  }
}

// Retry wrapper with exponential backoff
async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable = error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNREFUSED' ||
        error.message?.includes('timeout') ||
        error.message?.includes('429') ||
        (error.response?.status >= 500);

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.log(`  ⚠️ Retry ${attempt}/${maxRetries} after ${delay}ms: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// Analyze image with Google Vision API - DYNAMIC AI-powered filtering
// Supports both static fallback and AI-generated valid/reject keywords
async function analyzeProductImage(imageUrl, searchTerm, imageIndex = 0, dynamicKeywords = null) {
  const startTime = Date.now();
  try {
    if (!GOOGLE_VISION_API_KEY && !process.env.GOOGLE_APPLICATION_CREDENTIALS && !GOOGLE_CREDENTIALS_JSON) {
      return true; // Default pass if no credentials
    }

    // Use retry wrapper for the entire operation
    return await withRetry(async () => {
      // Download image (silent - batch progress shown at batch level)
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const imageBuffer = Buffer.from(response.data);
      const base64Image = imageBuffer.toString('base64');

      let labels = [];

      // Try service account first, fallback to API key
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS || GOOGLE_CREDENTIALS_JSON) {
        const vision = require('@google-cloud/vision');
        const client = new vision.ImageAnnotatorClient();
        const [result] = await client.labelDetection({
          image: { content: imageBuffer }
        });
        labels = result.labelAnnotations || [];
      } else if (GOOGLE_VISION_API_KEY) {
        const visionResponse = await axios.post(
          `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`,
          {
            requests: [{
              image: { content: base64Image },
              features: [{ type: 'LABEL_DETECTION', maxResults: 15 }]
            }]
          },
          { timeout: 15000 }
        );
        labels = visionResponse.data.responses[0]?.labelAnnotations || [];
      }

      const detectedLabels = labels.map(l => l.description.toLowerCase());
      // Log removed - batch summary provides progress

      // ===========================================
      // AI-POWERED DYNAMIC FILTERING
      // ===========================================

      let validLabels = [];
      let rejectLabels = [];

      if (dynamicKeywords && dynamicKeywords.valid && dynamicKeywords.reject) {
        // Use AI-generated keywords
        validLabels = dynamicKeywords.valid.map(l => l.toLowerCase());
        rejectLabels = dynamicKeywords.reject.map(l => l.toLowerCase());

        // ===== CRITICAL: CHECK REJECT LABELS FIRST =====
        // This catches false positives like pillows in a throw search
        const hasRejectLabel = detectedLabels.some(label =>
          rejectLabels.some(reject =>
            label.includes(reject) || reject.includes(label)
          )
        );

        if (hasRejectLabel) {
          const matchedReject = detectedLabels.filter(label =>
            rejectLabels.some(reject =>
              label.includes(reject) || reject.includes(label)
            )
          );
          return false; // Rejected by: matched reject labels
        }

        // Check valid labels
        const hasValidMatch = detectedLabels.some(label =>
          validLabels.some(valid =>
            label.includes(valid) || valid.includes(label)
          )
        );

        if (hasValidMatch) {
          return true; // Passed: valid label match
        }

        return false; // Rejected: no valid labels
      }

      // ===========================================
      // FALLBACK: Static keyword expansion
      // ===========================================
      const searchLower = searchTerm.toLowerCase();
      const searchWords = searchLower.split(/[\s+]+/).filter(w => w.length > 2);

      // Static keyword expansions as fallback
      const keywordExpansions = {
        'blanket': ['blanket', 'throw', 'textile', 'fabric', 'fleece', 'bedding', 'wool', 'fur', 'plush', 'soft'],
        'throw': ['throw', 'blanket', 'textile', 'fabric', 'wool', 'fur', 'soft', 'cozy', 'plush'],
        'pillow': ['pillow', 'cushion', 'textile', 'fabric', 'bedding', 'soft'],
        'phone': ['phone', 'mobile', 'smartphone', 'device', 'electronic', 'screen', 'case'],
        'dog': ['dog', 'pet', 'animal', 'canine', 'collar', 'leash', 'toy'],
        'cat': ['cat', 'pet', 'animal', 'feline', 'toy'],
        'light': ['light', 'lamp', 'led', 'lighting', 'bulb'],
        'kitchen': ['kitchen', 'cookware', 'utensil', 'cooking'],
        'bag': ['bag', 'handbag', 'purse', 'backpack', 'luggage']
      };

      let validCategories = new Set();
      searchWords.forEach(word => {
        validCategories.add(word);
        if (keywordExpansions[word]) {
          keywordExpansions[word].forEach(related => validCategories.add(related));
        }
        Object.keys(keywordExpansions).forEach(key => {
          if (word.includes(key) || key.includes(word)) {
            keywordExpansions[key].forEach(related => validCategories.add(related));
          }
        });
      });

      const validCategoriesArray = Array.from(validCategories);
      const hasValidMatch = detectedLabels.some(label =>
        validCategoriesArray.some(valid =>
          label.includes(valid) || valid.includes(label)
        )
      );

      const hasSearchTermMatch = searchWords.some(word =>
        detectedLabels.some(label => label.includes(word) || word.includes(label))
      );

      if (hasValidMatch || hasSearchTermMatch) {
        return true;
      }

      return false;
    }); // End withRetry callback

  } catch (error) {
    console.error('Vision API error:', error.message);
    // On error, default to PASS (don't reject due to API issues)
    return true;
  }
}


// Removed Puppeteer scraping - using CJ API exclusively for better reliability and speed

// Clear keyword cache endpoint
app.get('/api/clear-cache', async (req, res) => {
  try {
    await clearKeywordCache();
    res.json({ success: true, message: 'Keyword cache cleared' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API Routes
app.post('/api/scrape', async (req, res) => {
  const requestId = Date.now().toString(36);
  const scrapeId = generateScrapeId();
  console.log(`[${requestId}] POST /api/scrape`, req.body);

  const { searchUrl, searchTerm, useImageDetection = true } = req.body;

  if (!searchUrl && !searchTerm) {
    return res.status(400).json({ error: 'searchUrl or searchTerm required' });
  }

  // Require CJ API token
  if (!CJ_API_TOKEN) {
    return res.status(500).json({
      error: 'CJ_API_TOKEN environment variable is required. Puppeteer scraping has been removed for better reliability.'
    });
  }

  // Track this scrape session for cancellation
  activeScrapes.set(scrapeId, { cancelled: false, startedAt: Date.now() });

  try {
    console.log('[API MODE] Using CJ Official API');
    console.log(`[${requestId}] Scrape ID: ${scrapeId}`);

    // Parse search term and filters from URL if provided
    // BUGFIX: Check BOTH searchUrl and searchTerm for CJ URLs (frontend may pass URL as searchTerm)
    let keyword = searchTerm || searchUrl;
    let filters = {};

    // Check if searchUrl OR searchTerm contains a CJ URL
    const urlToParse = (searchUrl && searchUrl.includes('cjdropshipping.com')) ? searchUrl
      : (searchTerm && searchTerm.includes('cjdropshipping.com')) ? searchTerm
        : null;

    if (urlToParse) {
      const parsed = parseCJUrl(urlToParse);
      keyword = parsed.keyword;
      filters = parsed.filters;
      console.log('Parsed URL:', { keyword, filters });
    }

    // Check for cancellation
    if (activeScrapes.get(scrapeId)?.cancelled) {
      throw new Error('Scrape cancelled by user');
    }

    // ========================================
    // CATEGORY VALIDATION: Check if URL id is a valid category
    // ========================================
    let validatedCategoryId = null;
    let categoryInfo = null;
    const urlCategoryId = filters.categoryId || filters.id;

    if (urlCategoryId) {
      try {
        // Fetch category tree from CJ
        const categoryData = await getCategoryIndex(CJ_API_TOKEN);

        // Validate the category ID
        if (isValidCategoryId(urlCategoryId, categoryData)) {
          validatedCategoryId = urlCategoryId;
          categoryInfo = getCategoryById(urlCategoryId, categoryData);
          console.log('[Category] ✓ Valid category found:', {
            id: validatedCategoryId,
            name: categoryInfo?.name || 'Unknown',
            level: categoryInfo?.level || 'Unknown',
            path: categoryInfo?.path || 'Unknown'
          });
        } else {
          console.warn('[Category] ✗ Invalid category ID from URL:', urlCategoryId);
          console.log('[Category] This may be a search filter or session ID, not a category');
          console.log('[Category] Proceeding WITHOUT category filter');
        }
      } catch (error) {
        console.error('[Category] Failed to validate category:', error.message);
        console.log('[Category] Proceeding WITHOUT category filter due to error');
      }
    } else {
      console.log('[Category] No category ID in URL filters');
    }

    // DEBUG: Log filters being passed to CJ API  
    console.log('[DEBUG] Filters being passed:', {
      startWarehouseInventory: filters.startWarehouseInventory,
      endWarehouseInventory: filters.endWarehouseInventory,
      verifiedWarehouse: filters.verifiedWarehouse,
      categoryId: validatedCategoryId || 'NONE (not validated or invalid)'
    });

    // FIXED: Fetch ALL pages (up to MAX_OFFSET limit)
    const apiResult = await searchCJProducts(keyword, CJ_API_TOKEN, {
      pageNum: 1,
      pageSize: 200, // Max allowed by CJ API
      verifiedWarehouse: filters.verifiedWarehouse,
      categoryId: validatedCategoryId, // Only use VALIDATED category ID
      startWarehouseInventory: filters.startWarehouseInventory || null,
      endWarehouseInventory: filters.endWarehouseInventory || null,
      fetchAllPages: true,
      scrapeId: scrapeId
    });

    if (!apiResult.success) {
      throw new Error(apiResult.error || 'CJ API request failed');
    }

    // Check for cancellation
    if (activeScrapes.get(scrapeId)?.cancelled) {
      throw new Error('Scrape cancelled by user');
    }

    // Apply text filtering (cj-api-scraper transforms productNameEn to 'title')
    let textFiltered = apiResult.products.filter(p => isRelevantProduct(p.title || '', keyword));

    // BUG FIX: Limit total products to prevent runaway scrapes
    const MAX_PRODUCTS_TO_PROCESS = 1000;
    if (textFiltered.length > MAX_PRODUCTS_TO_PROCESS) {
      console.log(`⚠️ Limiting Vision analysis to first ${MAX_PRODUCTS_TO_PROCESS} products (found ${textFiltered.length})`);
      textFiltered = textFiltered.slice(0, MAX_PRODUCTS_TO_PROCESS);
    }

    // Apply image detection if enabled
    // BATCH PROCESSING: Process 50 images at a time for max speed (2GB RAM has headroom)
    // Batch size: 10 for 1GB, 25 for 2GB (safe), 50 for 2GB (fast), 100 for 4GB+
    const VISION_BATCH_SIZE = 50; // 50 parallel requests = max speed for 2GB
    let finalProducts = textFiltered;
    const SCRAPE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max scrape time
    const scrapeStartTime = Date.now();

    if (useImageDetection && textFiltered.length > 0) {
      logMemory('VISION_START');

      // ===============================================
      // NEW: Generate dynamic AI keywords for filtering
      // ===============================================
      let dynamicKeywords = null;
      if (GEMINI_API_KEY) {
        console.log(`\n🤖 [AI] Generating dynamic keywords for "${keyword}"...`);
        try {
          dynamicKeywords = await generateDynamicKeywords(keyword, GEMINI_API_KEY);
          console.log(`🤖 [AI] Valid labels: ${dynamicKeywords.valid?.slice(0, 5).join(', ')}...`);
          console.log(`🤖 [AI] Reject labels: ${dynamicKeywords.reject?.join(', ') || 'none'}`);
          console.log(`🤖 [AI] Confidence: ${dynamicKeywords.confidence || 'unknown'}`);
        } catch (aiError) {
          console.log(`⚠️ [AI] Keyword generation failed: ${aiError.message}, using static fallback`);
        }
      } else {
        console.log(`ℹ️ [AI] No GEMINI_API_KEY, using static keyword matching`);
      }

      console.log(`Analyzing ${textFiltered.length} products with Google Vision in batches of ${VISION_BATCH_SIZE}...`);
      console.log(`Estimated time: ${Math.ceil(textFiltered.length / VISION_BATCH_SIZE * 1.5)} seconds`);
      const imageFiltered = [];
      const totalBatches = Math.ceil(textFiltered.length / VISION_BATCH_SIZE);

      // BATCH PROCESSING: Process VISION_BATCH_SIZE images in parallel
      for (let i = 0; i < textFiltered.length; i += VISION_BATCH_SIZE) {
        // Check for cancellation
        if (activeScrapes.get(scrapeId)?.cancelled) {
          console.log(`[${requestId}] ⛔ Scrape cancelled during Vision processing`);
          break;
        }

        // Check for timeout
        if (Date.now() - scrapeStartTime > SCRAPE_TIMEOUT_MS) {
          console.log(`[${requestId}] ⏱️ Scrape timeout reached (${SCRAPE_TIMEOUT_MS / 1000 / 60} minutes), stopping...`);
          break;
        }

        const batch = textFiltered.slice(i, i + VISION_BATCH_SIZE);
        const batchNum = Math.floor(i / VISION_BATCH_SIZE) + 1;

        console.log(`  Batch ${batchNum}/${totalBatches}: processing ${batch.length} images...`);
        logMemory(`BATCH_${batchNum}_START`);

        // Process batch in PARALLEL for speed
        const batchResults = await Promise.all(
          batch.map(async (product, idx) => {
            try {
              if (product.image) {
                const passed = await analyzeProductImage(product.image, keyword, i + idx, dynamicKeywords);
                return { product, passed };
              }
              return { product, passed: false };
            } catch (err) {
              console.error(`  [${i + idx}] Vision error: ${err.message}`);
              return { product, passed: false };
            }
          })
        );

        // Collect passed products
        batchResults.forEach(result => {
          if (result.passed) {
            imageFiltered.push(result.product);
          }
        });

        const passedCount = batchResults.filter(r => r.passed).length;
        console.log(`  Batch ${batchNum}/${totalBatches}: ${passedCount}/${batch.length} passed`);
        logMemory(`BATCH_${batchNum}_END`);

        // Force garbage collection hint between batches if available
        if (global.gc) {
          global.gc();
        }

        // Small delay between batches to allow memory cleanup (500ms)
        if (i + VISION_BATCH_SIZE < textFiltered.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.log(`Vision analysis complete: ${imageFiltered.length}/${textFiltered.length} passed`);
      logMemory('VISION_END');
      finalProducts = imageFiltered;
    }

    // Cleanup scrape session
    activeScrapes.delete(scrapeId);

    const results = {
      success: true,
      method: 'CJ_API',
      searchTerm: keyword,
      filters: filters,
      totalFound: apiResult.totalProducts,
      maxFetchable: apiResult.maxFetchablePages ? apiResult.maxFetchablePages * 200 : null,
      pagesScraped: apiResult.fetchedPages || 1,
      textFiltered: textFiltered.length,
      imageFiltered: useImageDetection ? finalProducts.length : null,
      filtered: finalProducts.length,
      passRate: ((finalProducts.length / apiResult.totalProducts) * 100).toFixed(1) + '%',
      products: finalProducts,
      imageDetectionUsed: useImageDetection,
      scrapeId: scrapeId
    };

    // Clean summary log
    console.log(`\n========== SCRAPE SUMMARY ==========`);
    console.log(`Search Term: "${keyword}"`);
    console.log(`Filters: ${JSON.stringify(filters)}`);
    const usedCategoryId = filters.categoryId || filters.id || null;
    console.log(`Category ID: ${usedCategoryId || 'NONE - will return ALL products!'}`);
    console.log(`---`);
    console.log(`📥 CJ API: ${apiResult.totalProducts} total (${apiResult.fetchedPages || 1} pages scraped)`);
    if (apiResult.maxFetchablePages && apiResult.totalProducts > apiResult.maxFetchablePages * 200) {
      console.log(`⚠️  Note: Only ${apiResult.maxFetchablePages * 200} products accessible (API offset limit: ${MAX_OFFSET})`);
    }
    console.log(`📥 Actually Fetched: ${apiResult.actualFetched || apiResult.products?.length || 0} products`);
    console.log(`---`);
    console.log(`📝 Text Filter: ${textFiltered.length}/${apiResult.actualFetched || apiResult.totalProducts} passed (${((textFiltered.length / (apiResult.actualFetched || apiResult.totalProducts)) * 100).toFixed(1)}%)`);
    if (useImageDetection) {
      console.log(`🖼️  Image Filter: ${finalProducts.length}/${textFiltered.length} passed (${textFiltered.length > 0 ? ((finalProducts.length / textFiltered.length) * 100).toFixed(1) : 0}%)`);
    }
    console.log(`---`);
    console.log(`✅ FINAL: ${finalProducts.length} products (${results.passRate} overall pass rate)`);
    console.log(`=====================================\n`);

    res.json({ ...results, requestId });
  } catch (error) {
    // Cleanup scrape session on error
    activeScrapes.delete(scrapeId);
    console.error(`[${requestId}] Error:`, error);
    res.status(500).json({ error: error.message, requestId, scrapeId });
  }
});

// Cancel a scrape in progress
app.post('/api/scrape/cancel', (req, res) => {
  const { scrapeId } = req.body;

  if (!scrapeId) {
    return res.status(400).json({ error: 'scrapeId is required' });
  }

  if (activeScrapes.has(scrapeId)) {
    activeScrapes.get(scrapeId).cancelled = true;
    cancelScrape(scrapeId); // Also cancel in cj-api-scraper
    console.log(`[CANCEL] Scrape ${scrapeId} cancelled`);
    res.json({ success: true, message: `Scrape ${scrapeId} cancelled` });
  } else {
    res.json({ success: false, message: 'Scrape not found or already completed' });
  }
});

// Cancel all active scrapes
app.post('/api/scrape/cancel-all', (req, res) => {
  const cancelled = [];
  activeScrapes.forEach((session, id) => {
    session.cancelled = true;
    cancelScrape(id);
    cancelled.push(id);
  });
  activeScrapes.clear();
  console.log(`[CANCEL] All scrapes cancelled: ${cancelled.length}`);
  res.json({ success: true, cancelled: cancelled.length, ids: cancelled });
});

// Get CJ categories endpoint
app.get('/api/categories', async (req, res) => {
  if (!CJ_API_TOKEN) {
    return res.status(500).json({ error: 'CJ_API_TOKEN environment variable is required' });
  }

  try {
    const result = await getCJCategories(CJ_API_TOKEN);

    if (!result.success) {
      throw new Error(result.error || 'Failed to fetch categories');
    }

    // Filter to only level 3 categories (the ones with IDs)
    const level3Categories = result.categories.filter(cat => cat.level === 3);

    res.json({
      success: true,
      categories: level3Categories,
      total: level3Categories.length
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CSV IMPORT ENDPOINTS
// ============================================

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.csv', '.gz', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .csv, .gz, and .zip files are allowed'));
    }
  }
});

// POST /api/import-csv - Upload and parse CSV
app.post('/api/import-csv', upload.single('file'), async (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/import-csv`);

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded', requestId });
  }

  try {
    let csvData;
    const ext = path.extname(req.file.originalname).toLowerCase();
    console.log(`[${requestId}] Processing file: ${req.file.originalname} (${ext})`);

    if (ext === '.gz') {
      // Decompress gzip
      csvData = zlib.gunzipSync(req.file.buffer).toString('utf8');
    } else if (ext === '.zip') {
      // Extract from zip
      const zip = new AdmZip(req.file.buffer);
      const zipEntries = zip.getEntries();
      const csvEntry = zipEntries.find(e => e.entryName.endsWith('.csv'));
      if (!csvEntry) {
        return res.status(400).json({ error: 'No CSV file found in zip', requestId });
      }
      csvData = csvEntry.getData().toString('utf8');
    } else {
      // Plain CSV
      csvData = req.file.buffer.toString('utf8');
    }

    // Parse CSV
    const records = parse(csvData, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true
    });

    console.log(`[${requestId}] Parsed ${records.length} rows`);

    // Extract products, group by Handle
    const productsMap = new Map();

    for (const row of records) {
      const handle = row['Handle'] || row['handle'] || '';
      const title = row['Title'] || row['title'] || '';
      const sku = row['Variant SKU'] || row['variant_sku'] || '';
      
      if (!handle) continue;

      if (!productsMap.has(handle)) {
        productsMap.set(handle, {
          handle,
          title,
          skus: sku ? [sku] : [],
          variantCount: 1
        });
      } else {
        const existing = productsMap.get(handle);
        existing.variantCount++;
        if (sku && !existing.skus.includes(sku)) {
          existing.skus.push(sku);
        }
      }
    }

    const products = Array.from(productsMap.values());
    console.log(`[${requestId}] Found ${products.length} unique products`);

    res.json({
      success: true,
      requestId,
      totalRows: records.length,
      products: products.map(p => ({
        handle: p.handle,
        title: p.title,
        sku: p.skus[0] || '',
        variantCount: p.variantCount
      }))
    });

  } catch (error) {
    console.error(`[${requestId}] CSV parse error:`, error);
    res.status(500).json({ error: error.message, requestId });
  }
});

// POST /api/match-products - Match titles to CJ products
app.post('/api/match-products', async (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/match-products`);

  const { products } = req.body;

  if (!products || !Array.isArray(products)) {
    return res.status(400).json({ error: 'Products array required', requestId });
  }

  if (!CJ_API_TOKEN) {
    return res.status(500).json({ error: 'CJ_API_TOKEN not configured', requestId });
  }

  try {
    const results = [];
    const RATE_LIMIT_DELAY = 300; // 300ms between requests

    for (let i = 0; i < products.length; i++) {
      const { handle, title } = products[i];
      console.log(`[${requestId}] Matching ${i + 1}/${products.length}: "${title.substring(0, 50)}..."`);

      try {
        // Search CJ API for matching products
        // Use first few words of title for better matches
        const searchWords = title.split(' ').slice(0, 5).join(' ');
        
        const response = await axios.get('https://developers.cjdropshipping.com/api/2.0/product/list', {
          params: {
            productNameEn: searchWords,
            pageNum: 1,
            pageSize: 5
          },
          headers: {
            'CJ-Access-Token': CJ_API_TOKEN
          },
          timeout: 15000
        });

        const cjProducts = response.data?.data?.list || [];
        
        // Calculate confidence scores
        const matches = cjProducts.map(cj => {
          const cjTitle = (cj.productNameEn || '').toLowerCase();
          const shopifyTitle = title.toLowerCase();
          
          // Simple word overlap scoring
          const shopifyWords = shopifyTitle.split(/\s+/).filter(w => w.length > 2);
          const cjWords = cjTitle.split(/\s+/).filter(w => w.length > 2);
          
          const matchingWords = shopifyWords.filter(w => cjWords.some(cw => cw.includes(w) || w.includes(cw)));
          const confidence = shopifyWords.length > 0 ? Math.round((matchingWords.length / shopifyWords.length) * 100) : 0;
          
          return {
            cjProductId: cj.pid,
            cjTitle: cj.productNameEn,
            cjImage: cj.productImage,
            cjPrice: cj.sellPrice,
            confidence
          };
        }).sort((a, b) => b.confidence - a.confidence);

        results.push({
          handle,
          title,
          matches,
          bestMatch: matches[0] || null
        });

      } catch (matchError) {
        console.error(`[${requestId}] Match error for "${title}":`, matchError.message);
        results.push({
          handle,
          title,
          matches: [],
          bestMatch: null,
          error: matchError.message
        });
      }

      // Rate limit delay
      if (i < products.length - 1) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
      }
    }

    res.json({
      success: true,
      requestId,
      results
    });

  } catch (error) {
    console.error(`[${requestId}] Match products error:`, error);
    res.status(500).json({ error: error.message, requestId });
  }
});

// POST /api/link-products - Apply confirmed matches
app.post('/api/link-products', async (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/link-products`);

  const { links, shopifyStore, shopifyToken } = req.body;

  if (!links || !Array.isArray(links)) {
    return res.status(400).json({ error: 'Links array required', requestId });
  }

  if (!shopifyStore || !shopifyToken) {
    return res.status(400).json({ error: 'Shopify credentials required', requestId });
  }

  const cleanStoreUrl = shopifyStore.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const GRAPHQL_ENDPOINT = `https://${cleanStoreUrl}/admin/api/2024-01/graphql.json`;

  const results = {
    success: 0,
    failed: 0,
    errors: []
  };

  for (const link of links) {
    const { shopifyHandle, cjProductId } = link;
    
    if (!shopifyHandle || !cjProductId) {
      results.failed++;
      results.errors.push({ handle: shopifyHandle, error: 'Missing handle or CJ product ID' });
      continue;
    }

    try {
      // First, find the Shopify product by handle
      const findQuery = `
        query FindProduct($handle: String!) {
          productByHandle(handle: $handle) {
            id
            title
          }
        }
      `;

      const findResponse = await axios.post(GRAPHQL_ENDPOINT, {
        query: findQuery,
        variables: { handle: shopifyHandle }
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': shopifyToken
        },
        timeout: 15000
      });

      const product = findResponse.data?.data?.productByHandle;
      if (!product) {
        results.failed++;
        results.errors.push({ handle: shopifyHandle, error: 'Product not found in Shopify' });
        continue;
      }

      // Set the CJ product ID metafield
      const metafieldMutation = `
        mutation SetMetafield($input: ProductInput!) {
          productUpdate(input: $input) {
            product {
              id
              metafield(namespace: "custom", key: "cj_product_id") {
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const metafieldResponse = await axios.post(GRAPHQL_ENDPOINT, {
        query: metafieldMutation,
        variables: {
          input: {
            id: product.id,
            metafields: [{
              namespace: 'custom',
              key: 'cj_product_id',
              value: cjProductId,
              type: 'single_line_text_field'
            }]
          }
        }
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': shopifyToken
        },
        timeout: 15000
      });

      const userErrors = metafieldResponse.data?.data?.productUpdate?.userErrors || [];
      if (userErrors.length > 0) {
        results.failed++;
        results.errors.push({ handle: shopifyHandle, error: userErrors[0].message });
      } else {
        results.success++;
        console.log(`[${requestId}] ✅ Linked ${shopifyHandle} → ${cjProductId}`);
      }

      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 200));

    } catch (linkError) {
      console.error(`[${requestId}] Link error for ${shopifyHandle}:`, linkError.message);
      results.failed++;
      results.errors.push({ handle: shopifyHandle, error: linkError.message });
    }
  }

  res.json({
    success: true,
    requestId,
    linked: results.success,
    failed: results.failed,
    errors: results.errors
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    endpoints: ['/api/scrape', '/api/categories', '/api/upload-shopify', '/health']
  });
});

// Track active uploads for cancellation
const activeUploads = new Map();

// Upload products to Shopify
app.post('/api/upload-shopify', async (req, res) => {
  const requestId = Date.now().toString(36);
  const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  console.log(`[${requestId}] POST /api/upload-shopify`);

  const { products, markup = 250, shopifyStore, shopifyToken } = req.body;

  if (!products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'Products array is required', requestId });
  }

  if (!shopifyStore || !shopifyToken) {
    return res.status(400).json({
      error: 'Shopify credentials required. Configure your store in Settings.',
      requestId
    });
  }

  // No limit on products - upload all of them to Shopify
  // Using GraphQL productSet batch mutations for fast uploads with variants + images
  let productsToUpload = products;
  console.log(`[${requestId}] Preparing to upload ${productsToUpload.length} products with GraphQL productSet...`);

  // Track this upload for cancellation
  activeUploads.set(uploadId, { cancelled: false, startedAt: Date.now() });

  // GraphQL batch configuration
  const BATCH_SIZE = 30; // 30 products per GraphQL request (optimized for speed)

  // FIX: Strip any existing protocol from the store URL
  const cleanStoreUrl = shopifyStore.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const GRAPHQL_ENDPOINT = `https://${cleanStoreUrl}/admin/api/2026-01/graphql.json`;
  console.log(`[${requestId}] Using Shopify endpoint: ${GRAPHQL_ENDPOINT}`);

  // Helper: Build productSet input for GraphQL variables
  const buildProductSetInput = (product) => {
    const priceMatch = (product.price || '0').toString().match(/[\d.]+/);
    const price = priceMatch ? parseFloat(priceMatch[0]) : 0;
    const sellingPrice = price * (markup / 100);
    const comparePrice = sellingPrice * 1.3;

    const input = {
      title: product.title || 'Untitled Product',
      vendor: 'CJ Dropshipping',
      productType: 'Imported',
      status: 'ACTIVE', // Enum - GraphQL variables handle this automatically
      tags: ['dropship', 'cj', product.sourceKeyword || ''].filter(Boolean),
      // Single variant product - use default option
      productOptions: [{
        name: 'Title',
        position: 1,
        values: [{ name: 'Default Title' }]
      }],
      variants: [{
        optionValues: [{ optionName: 'Title', name: 'Default Title' }],
        price: sellingPrice.toFixed(2),
        compareAtPrice: comparePrice.toFixed(2),
        sku: product.sku || product.pid || '' // Use CJ product ID as SKU fallback
      }]
    };

    // Add image if available
    if (product.image) {
      input.files = [{
        originalSource: product.image,
        contentType: 'IMAGE' // Enum - GraphQL variables handle this automatically
      }];
    }

    // Store CJ Product ID in metafield for price sync
    if (product.pid) {
      input.metafields = [{
        namespace: 'custom',
        key: 'cj_product_id',
        value: product.pid,
        type: 'single_line_text_field'
      }];
    }

    return input;
  };

  try {
    const results = [];
    const batches = [];

    // Split products into batches
    for (let i = 0; i < productsToUpload.length; i += BATCH_SIZE) {
      batches.push(productsToUpload.slice(i, i + BATCH_SIZE));
    }

    console.log(`[${requestId}] Uploading ${productsToUpload.length} products in ${batches.length} batches of ${BATCH_SIZE}...`);

    // Process each batch
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];

      // Check for cancellation
      if (activeUploads.get(uploadId)?.cancelled) {
        console.log(`[${requestId}] ⛔ Upload cancelled at batch ${batchIndex + 1}/${batches.length}`);
        break;
      }

      // Build GraphQL mutation with variables (handles enums automatically!)
      const varDefs = batch.map((_, i) => `$input${i}: ProductSetInput!`).join(', ');
      const mutations = batch.map((_, i) => {
        const alias = `p${batchIndex * BATCH_SIZE + i}`;
        return `
          ${alias}: productSet(synchronous: true, input: $input${i}) {
            product { 
              id 
              title
              handle
            }
            userErrors { 
              field 
              message 
            }
          }
        `;
      }).join('\n');

      const mutation = `mutation BatchProductSet(${varDefs}) { ${mutations} }`;

      // Build variables object - JSON format, GraphQL handles type conversion!
      const variables = {};
      batch.forEach((product, i) => {
        variables[`input${i}`] = buildProductSetInput(product);
      });

      try {
        const response = await axios.post(GRAPHQL_ENDPOINT, {
          query: mutation,
          variables: variables // ✅ GraphQL handles enum conversion automatically!
        }, {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': shopifyToken
          },
          timeout: 120000 // 2 minute timeout for batch with images
        });

        const { data, errors, extensions } = response.data;

        // Check for GraphQL-level errors
        if (errors) {
          console.error(`[${requestId}] GraphQL errors:`, errors);
          batch.forEach(product => {
            results.push({
              title: product.title,
              success: false,
              error: errors[0]?.message || 'GraphQL error'
            });
          });
        } else if (data) {
          // Process each aliased result
          Object.keys(data).forEach((alias, index) => {
            const result = data[alias];
            const product = batch[index];

            if (result?.product) {
              results.push({
                title: product.title,
                success: true,
                productId: result.product.id,
                handle: result.product.handle
              });
            } else if (result?.userErrors?.length > 0) {
              results.push({
                title: product.title,
                success: false,
                error: result.userErrors.map(e => e.message).join(', ')
              });
            } else {
              results.push({
                title: product.title,
                success: false,
                error: 'Unknown error'
              });
            }
          });
        }

        // Check throttle status and wait if needed
        const throttle = extensions?.cost?.throttleStatus;
        if (throttle) {
          const availablePercent = throttle.currentlyAvailable / throttle.maximumAvailable;
          console.log(`[${requestId}] ✅ Batch ${batchIndex + 1}/${batches.length} done | Rate limit: ${(availablePercent * 100).toFixed(0)}%`);

          if (availablePercent < 0.2) {
            console.log(`[${requestId}] ⏳ Low rate limit, waiting 3s...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          } else if (availablePercent < 0.4) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } else {
          console.log(`[${requestId}] ✅ Batch ${batchIndex + 1}/${batches.length} done`);
        }

        // Delay between batches
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`[${requestId}] ❌ Batch ${batchIndex + 1} failed:`, error.response?.data || error.message);

        // Check for rate limiting
        if (error.response?.status === 429) {
          const retryAfter = parseInt(error.response.headers['retry-after']) || 3;
          console.log(`[${requestId}] ⏳ Rate limited, retrying after ${retryAfter}s...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          batchIndex--; // Retry this batch
          continue;
        }

        // Mark all products in batch as failed
        batch.forEach(product => {
          results.push({
            title: product.title,
            success: false,
            error: error.response?.data?.errors?.[0]?.message || error.message
          });
        });
      }
    }

    // Cleanup
    activeUploads.delete(uploadId);

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    console.log(`[${requestId}] ========== UPLOAD COMPLETE ==========`);
    console.log(`[${requestId}] ✅ Success: ${successCount}/${products.length}`);
    console.log(`[${requestId}] ❌ Failed: ${failedCount}/${products.length}`);
    console.log(`[${requestId}] ======================================`);

    res.json({
      success: true,
      requestId,
      total: products.length,
      uploaded: successCount,
      failed: failedCount,
      results,
      uploadId,
      method: 'GraphQL productSet Batch',
      batchSize: BATCH_SIZE
    });

  } catch (error) {
    activeUploads.delete(uploadId);
    console.error(`[${requestId}] Error:`, error);
    res.status(500).json({ error: error.message, requestId });
  }
});

// Cancel all active uploads
app.post('/api/upload-shopify/cancel-all', (req, res) => {
  const cancelled = [];
  activeUploads.forEach((session, id) => {
    session.cancelled = true;
    cancelled.push(id);
  });
  activeUploads.clear();
  console.log(`[CANCEL] All uploads cancelled: ${cancelled.length}`);
  res.json({ success: true, cancelled: cancelled.length, ids: cancelled });
});

// ============================================
// PRICE SYNC ENDPOINTS
// ============================================

// Preview price changes (dry run)
app.post('/api/sync-prices/preview', async (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/sync-prices/preview`);

  const { shopifyStore, shopifyToken, options = {} } = req.body;

  if (!shopifyStore || !shopifyToken) {
    return res.status(400).json({
      error: 'Shopify credentials required',
      requestId
    });
  }

  if (!CJ_API_TOKEN) {
    return res.status(400).json({
      error: 'CJ API token not configured on server',
      requestId
    });
  }

  try {
    const preview = await generatePreview(shopifyStore, shopifyToken, CJ_API_TOKEN, options);
    
    res.json({
      success: preview.success,
      requestId,
      ...preview
    });
  } catch (error) {
    console.error(`[${requestId}] Preview error:`, error);
    res.status(500).json({
      error: error.message,
      requestId
    });
  }
});

// Execute price sync
app.post('/api/sync-prices', async (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/sync-prices`);

  const { shopifyStore, shopifyToken, options = {} } = req.body;

  if (!shopifyStore || !shopifyToken) {
    return res.status(400).json({
      error: 'Shopify credentials required',
      requestId
    });
  }

  if (!CJ_API_TOKEN) {
    return res.status(400).json({
      error: 'CJ API token not configured on server',
      requestId
    });
  }

  try {
    const results = await executeSync(shopifyStore, shopifyToken, CJ_API_TOKEN, options);
    
    res.json({
      success: results.success,
      requestId,
      ...results
    });
  } catch (error) {
    console.error(`[${requestId}] Sync error:`, error);
    res.status(500).json({
      error: error.message,
      requestId
    });
  }
});

// Sync single product by Shopify ID
app.post('/api/sync-prices/product/:productId', async (req, res) => {
  const requestId = Date.now().toString(36);
  const { productId } = req.params;
  console.log(`[${requestId}] POST /api/sync-prices/product/${productId}`);

  const { shopifyStore, shopifyToken, options = {} } = req.body;

  if (!shopifyStore || !shopifyToken) {
    return res.status(400).json({
      error: 'Shopify credentials required',
      requestId
    });
  }

  if (!CJ_API_TOKEN) {
    return res.status(400).json({
      error: 'CJ API token not configured on server',
      requestId
    });
  }

  try {
    const result = await syncSingleProduct(productId, shopifyStore, shopifyToken, CJ_API_TOKEN, options);
    
    res.json({
      success: result.success,
      requestId,
      ...result
    });
  } catch (error) {
    console.error(`[${requestId}] Single product sync error:`, error);
    res.status(500).json({
      error: error.message,
      requestId
    });
  }
});

// Set CJ Product ID metafield on existing product
app.post('/api/set-cj-metafield', async (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/set-cj-metafield`);

  const { productId, cjProductId, shopifyStore, shopifyToken } = req.body;

  if (!productId || !cjProductId || !shopifyStore || !shopifyToken) {
    return res.status(400).json({
      error: 'Missing required fields: productId, cjProductId, shopifyStore, shopifyToken',
      requestId
    });
  }

  try {
    const success = await setCJMetafield(productId, cjProductId, shopifyStore, shopifyToken);
    
    res.json({
      success,
      requestId,
      productId,
      cjProductId
    });
  } catch (error) {
    console.error(`[${requestId}] Metafield error:`, error);
    res.status(500).json({
      error: error.message,
      requestId
    });
  }
});

// Get price sync config
app.get('/api/sync-prices/config', (req, res) => {
  try {
    const configPath = path.join(__dirname, 'config/price_sync_config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json({ success: true, config });
  } catch (error) {
    res.json({
      success: true,
      config: {
        markup_multiplier: 2.0,
        min_price: 19.99,
        max_price: null,
        round_to: 0.95,
        show_compare_at: false,
        compare_at_markup: 1.3
      }
    });
  }
});

// Update price sync config
app.post('/api/sync-prices/config', (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/sync-prices/config`);

  const { config } = req.body;

  if (!config) {
    return res.status(400).json({ error: 'Config object required', requestId });
  }

  try {
    const configPath = path.join(__dirname, 'config/price_sync_config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    res.json({ success: true, requestId, config });
  } catch (error) {
    console.error(`[${requestId}] Config save error:`, error);
    res.status(500).json({ error: error.message, requestId });
  }
});

// Test Shopify connection (proxy to avoid CORS)
app.post('/api/test-connection', async (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/test-connection`);

  const { shopifyStore, shopifyToken } = req.body;

  if (!shopifyStore || !shopifyToken) {
    return res.status(400).json({
      success: false,
      error: 'Shopify store and token required'
    });
  }

  // Clean up store URL
  const cleanStore = shopifyStore.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  try {
    const response = await axios.get(`https://${cleanStore}/admin/api/2024-01/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': shopifyToken
      },
      timeout: 10000
    });

    res.json({
      success: true,
      shop: response.data.shop
    });
  } catch (error) {
    console.error(`[${requestId}] Connection test failed:`, error.message);
    res.status(400).json({
      success: false,
      error: error.response?.data?.errors || error.message
    });
  }
});

// ============================================
// CSV IMPORT ENDPOINTS
// ============================================

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// Upload and parse CSV
app.post('/api/import-csv', upload.single('file'), async (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/import-csv`);

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded', requestId });
  }

  try {
    let csvData = req.file.buffer;
    const filename = req.file.originalname.toLowerCase();

    // Decompress if needed
    if (filename.endsWith('.gz')) {
      console.log(`[${requestId}] Decompressing .gz file...`);
      csvData = zlib.gunzipSync(csvData);
    } else if (filename.endsWith('.zip')) {
      console.log(`[${requestId}] Extracting .zip file...`);
      const zip = new AdmZip(req.file.buffer);
      const entries = zip.getEntries();
      const csvEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.csv'));
      if (!csvEntry) {
        return res.status(400).json({ error: 'No CSV file found in ZIP', requestId });
      }
      csvData = csvEntry.getData();
    }

    // Parse CSV
    console.log(`[${requestId}] Parsing CSV (${(csvData.length / 1024 / 1024).toFixed(2)}MB)...`);
    const records = parse(csvData, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true
    });

    // Group by Handle (products have multiple variant rows)
    const productsMap = new Map();
    for (const row of records) {
      const handle = row['Handle'];
      if (!handle) continue;
      
      if (!productsMap.has(handle)) {
        productsMap.set(handle, {
          handle,
          title: row['Title'] || handle,
          sku: row['Variant SKU'] || null,
          vendor: row['Vendor'] || null,
          status: row['Status'] || 'active'
        });
      }
      // Use first non-empty SKU
      if (!productsMap.get(handle).sku && row['Variant SKU']) {
        productsMap.get(handle).sku = row['Variant SKU'];
      }
    }

    const products = Array.from(productsMap.values());
    console.log(`[${requestId}] Found ${products.length} unique products`);

    res.json({
      success: true,
      requestId,
      totalRows: records.length,
      uniqueProducts: products.length,
      products
    });

  } catch (error) {
    console.error(`[${requestId}] CSV parse error:`, error);
    res.status(500).json({ error: error.message, requestId });
  }
});

// Match products to CJ by title
app.post('/api/match-products', async (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/match-products`);

  const { products } = req.body;

  if (!products || !Array.isArray(products)) {
    return res.status(400).json({ error: 'Products array required', requestId });
  }

  if (!CJ_API_TOKEN) {
    return res.status(400).json({ error: 'CJ API token not configured', requestId });
  }

  const results = [];
  const batchSize = 10;

  console.log(`[${requestId}] Matching ${products.length} products...`);

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    
    try {
      // Search CJ by title (use first 3-4 words for better results)
      const searchTerms = product.title.split(/\s+/).slice(0, 4).join(' ');
      
      const response = await axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
        params: {
          productNameEn: searchTerms,
          pageNum: 1,
          pageSize: 5
        },
        headers: { 'CJ-Access-Token': CJ_API_TOKEN },
        timeout: 15000
      });

      const cjProducts = response.data?.data?.list || [];
      
      // Calculate similarity scores
      const matches = cjProducts.map(cj => {
        const similarity = titleSimilarity(product.title, cj.productNameEn || '');
        return {
          cjProductId: cj.pid,
          cjTitle: cj.productNameEn,
          cjPrice: cj.sellPrice,
          cjImage: cj.productImage,
          similarity: Math.round(similarity * 100)
        };
      }).sort((a, b) => b.similarity - a.similarity);

      results.push({
        handle: product.handle,
        title: product.title,
        sku: product.sku,
        matches: matches.slice(0, 3), // Top 3 matches
        bestMatch: matches[0] || null
      });

      // Rate limiting
      if ((i + 1) % batchSize === 0) {
        console.log(`[${requestId}] Matched ${i + 1}/${products.length}...`);
        await new Promise(r => setTimeout(r, 500));
      } else {
        await new Promise(r => setTimeout(r, 200));
      }

    } catch (error) {
      console.error(`[${requestId}] Error matching "${product.title}":`, error.message);
      results.push({
        handle: product.handle,
        title: product.title,
        sku: product.sku,
        matches: [],
        bestMatch: null,
        error: error.message
      });
    }
  }

  console.log(`[${requestId}] Matching complete`);

  res.json({
    success: true,
    requestId,
    total: products.length,
    matched: results.filter(r => r.bestMatch && r.bestMatch.similarity >= 50).length,
    results
  });
});

// Simple title similarity function
function titleSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const s2 = str2.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  
  if (s1 === s2) return 1;
  
  const words1 = new Set(s1.split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(s2.split(/\s+/).filter(w => w.length > 2));
  
  let matches = 0;
  for (const word of words1) {
    if (words2.has(word)) matches++;
  }
  
  const totalWords = Math.max(words1.size, words2.size);
  return totalWords > 0 ? matches / totalWords : 0;
}

// Link products (set metafields)
app.post('/api/link-products', async (req, res) => {
  const requestId = Date.now().toString(36);
  console.log(`[${requestId}] POST /api/link-products`);

  const { links, shopifyStore, shopifyToken } = req.body;

  if (!links || !Array.isArray(links)) {
    return res.status(400).json({ error: 'Links array required', requestId });
  }

  if (!shopifyStore || !shopifyToken) {
    return res.status(400).json({ error: 'Shopify credentials required', requestId });
  }

  const cleanStore = shopifyStore.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  let success = 0;
  let failed = 0;
  const results = [];

  for (const link of links) {
    if (!link.handle || !link.cjProductId) {
      failed++;
      continue;
    }

    try {
      // First, find the product ID by handle
      const searchResponse = await axios.post(
        `https://${cleanStore}/admin/api/2024-01/graphql.json`,
        {
          query: `
            query GetProduct($handle: String!) {
              productByHandle(handle: $handle) {
                id
                title
              }
            }
          `,
          variables: { handle: link.handle }
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': shopifyToken
          },
          timeout: 10000
        }
      );

      const product = searchResponse.data?.data?.productByHandle;
      if (!product) {
        failed++;
        results.push({ handle: link.handle, success: false, error: 'Product not found' });
        continue;
      }

      // Set the metafield
      const metafieldResponse = await axios.post(
        `https://${cleanStore}/admin/api/2024-01/graphql.json`,
        {
          query: `
            mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                metafields { id key value }
                userErrors { field message }
              }
            }
          `,
          variables: {
            metafields: [{
              ownerId: product.id,
              namespace: 'custom',
              key: 'cj_product_id',
              value: link.cjProductId,
              type: 'single_line_text_field'
            }]
          }
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': shopifyToken
          },
          timeout: 10000
        }
      );

      const errors = metafieldResponse.data?.data?.metafieldsSet?.userErrors;
      if (errors && errors.length > 0) {
        failed++;
        results.push({ handle: link.handle, success: false, error: errors[0].message });
      } else {
        success++;
        results.push({ handle: link.handle, success: true, productId: product.id });
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 200));

    } catch (error) {
      failed++;
      results.push({ handle: link.handle, success: false, error: error.message });
    }
  }

  console.log(`[${requestId}] Linking complete: ${success} success, ${failed} failed`);

  res.json({
    success: true,
    requestId,
    total: links.length,
    linked: success,
    failed,
    results
  });
});

// Serve React frontend (if build exists)
const frontendPath = path.join(__dirname, '../frontend/build');
if (fs.existsSync(frontendPath)) {
  console.log('✅ Frontend build found, serving static files');
  app.use(express.static(frontendPath));
  
  // SPA fallback - serve index.html for all non-API routes
  app.get('*', (req, res, next) => {
    // Skip API routes
    if (req.path.startsWith('/api/') || req.path === '/health') {
      return next();
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
} else {
  console.log('ℹ️  No frontend build found, API-only mode');
  
  // Root endpoint - API info (only when no frontend)
  app.get('/', (req, res) => {
    res.json({
      name: 'CJ Scraper V2 - Price Sync Edition',
      version: '2.0.0',
      status: 'running',
      endpoints: {
        health: '/health',
        scrape: '/api/scrape',
        categories: '/api/categories',
        uploadShopify: '/api/upload-shopify',
        priceSync: {
          preview: 'POST /api/sync-prices/preview',
          sync: 'POST /api/sync-prices',
          singleProduct: 'POST /api/sync-prices/product/:id',
          config: 'GET/POST /api/sync-prices/config',
          setMetafield: 'POST /api/set-cj-metafield'
        }
      },
      docs: 'https://github.com/RhysMckay7777/cj-scraper-v2/blob/main/PRICE_SYNC.md'
    });
  });
}

app.listen(PORT, () => {
  console.log(`✅ CJ Scraper V2 running on port ${PORT}`);
  console.log(`   Frontend: http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
