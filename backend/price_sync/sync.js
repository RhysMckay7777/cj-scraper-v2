/**
 * Price Sync Module
 * 
 * Main orchestrator for syncing CJ prices to Shopify.
 * Supports preview mode and batch updates.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const { fetchShopifyProducts, matchProducts, setCJMetafield } = require('./matcher');
const { calculatePrice, calculateChange, formatPrice, loadConfig } = require('./calculator');

/**
 * Update Shopify product price
 * @param {Object} product - Product with variant info
 * @param {number} newPrice - New price
 * @param {number|null} compareAtPrice - Compare at price (optional)
 * @param {string} shopifyStore - Shopify store URL
 * @param {string} shopifyToken - Shopify access token
 * @returns {Promise<Object>} Update result
 */
async function updateShopifyPrice(product, newPrice, compareAtPrice, shopifyStore, shopifyToken) {
  const cleanStoreUrl = shopifyStore.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const GRAPHQL_ENDPOINT = `https://${cleanStoreUrl}/admin/api/2024-01/graphql.json`;
  
  const mutation = `
    mutation UpdateVariantPrice($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        productVariant {
          id
          price
          compareAtPrice
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  
  const variantId = product.variantGraphqlId || `gid://shopify/ProductVariant/${product.variantId}`;
  
  const input = {
    id: variantId,
    price: newPrice.toFixed(2)
  };
  
  if (compareAtPrice !== null) {
    input.compareAtPrice = compareAtPrice.toFixed(2);
  }
  
  try {
    const response = await axios.post(GRAPHQL_ENDPOINT, {
      query: mutation,
      variables: { input }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': shopifyToken
      },
      timeout: 10000
    });
    
    const result = response.data.data?.productVariantUpdate;
    
    if (result?.userErrors?.length > 0) {
      return {
        success: false,
        error: result.userErrors.map(e => e.message).join(', ')
      };
    }
    
    return {
      success: true,
      newPrice: parseFloat(result.productVariant.price),
      newCompareAtPrice: result.productVariant.compareAtPrice 
        ? parseFloat(result.productVariant.compareAtPrice) 
        : null
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Generate sync preview
 * @param {string} shopifyStore - Shopify store URL
 * @param {string} shopifyToken - Shopify access token
 * @param {string} cjToken - CJ API token
 * @param {Object} options - Price calculation options
 * @returns {Promise<Object>} Preview data
 */
async function generatePreview(shopifyStore, shopifyToken, cjToken, options = {}) {
  console.log('[Sync] Generating price sync preview...');
  
  // Fetch all Shopify products
  const shopifyProducts = await fetchShopifyProducts(shopifyStore, shopifyToken);
  
  if (shopifyProducts.length === 0) {
    return {
      success: false,
      error: 'No products found in Shopify store'
    };
  }
  
  // Match to CJ products
  const { matched, unmatched } = await matchProducts(shopifyProducts, cjToken);
  
  // Calculate new prices
  const changes = [];
  let increases = 0;
  let decreases = 0;
  let noChange = 0;
  
  for (const product of matched) {
    const { price: newPrice, compareAtPrice } = calculatePrice(product.cjPrice, options);
    const { change, changePercent, direction } = calculateChange(product.currentPrice, newPrice);
    
    if (direction === 'increase') increases++;
    else if (direction === 'decrease') decreases++;
    else noChange++;
    
    changes.push({
      shopifyId: product.shopifyId,
      title: product.title,
      cjProductId: product.cjProductId,
      cjPrice: product.cjPrice,
      currentPrice: product.currentPrice,
      newPrice,
      compareAtPrice,
      change,
      changePercent,
      direction,
      matchMethod: product.matchMethod
    });
  }
  
  return {
    success: true,
    totalProducts: shopifyProducts.length,
    matchedProducts: matched.length,
    unmatchedProducts: unmatched.length,
    changes,
    summary: {
      increases,
      decreases,
      noChange
    },
    unmatched: unmatched.slice(0, 10) // Only return first 10 unmatched for preview
  };
}

/**
 * Execute price sync
 * @param {string} shopifyStore - Shopify store URL
 * @param {string} shopifyToken - Shopify access token
 * @param {string} cjToken - CJ API token
 * @param {Object} options - Sync options
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Object>} Sync results
 */
async function executeSync(shopifyStore, shopifyToken, cjToken, options = {}, onProgress = null) {
  const startTime = Date.now();
  console.log('[Sync] Starting price sync...');
  
  // Get preview data first
  const preview = await generatePreview(shopifyStore, shopifyToken, cjToken, options);
  
  if (!preview.success) {
    return preview;
  }
  
  const results = {
    success: true,
    totalProducts: preview.totalProducts,
    updated: 0,
    failed: 0,
    skipped: 0,
    changes: [],
    errors: []
  };
  
  const config = loadConfig();
  const rateLimitDelay = options.rate_limit_delay_ms || config.rate_limit_delay_ms || 500;
  
  // Only sync products with actual changes
  const toUpdate = preview.changes.filter(c => c.direction !== 'none');
  
  console.log(`[Sync] Updating ${toUpdate.length} products with price changes...`);
  
  for (let i = 0; i < toUpdate.length; i++) {
    const change = toUpdate[i];
    
    // Progress callback
    if (onProgress) {
      onProgress({
        current: i + 1,
        total: toUpdate.length,
        product: change.title
      });
    }
    
    try {
      const updateResult = await updateShopifyPrice(
        { variantId: change.shopifyId, ...change },
        change.newPrice,
        change.compareAtPrice,
        shopifyStore,
        shopifyToken
      );
      
      if (updateResult.success) {
        results.updated++;
        results.changes.push({
          ...change,
          status: 'updated'
        });
      } else {
        results.failed++;
        results.errors.push({
          shopifyId: change.shopifyId,
          title: change.title,
          error: updateResult.error
        });
      }
    } catch (error) {
      results.failed++;
      results.errors.push({
        shopifyId: change.shopifyId,
        title: change.title,
        error: error.message
      });
    }
    
    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
  }
  
  // Products with no change are skipped
  results.skipped = preview.changes.filter(c => c.direction === 'none').length;
  
  const duration = Math.round((Date.now() - startTime) / 1000);
  results.duration = duration;
  
  // Save log
  await saveLog(results);
  
  console.log(`[Sync] Complete! Updated: ${results.updated}, Failed: ${results.failed}, Skipped: ${results.skipped}`);
  console.log(`[Sync] Duration: ${duration} seconds`);
  
  return results;
}

/**
 * Save sync log to file
 * @param {Object} results - Sync results
 */
async function saveLog(results) {
  const logsDir = path.join(__dirname, '../logs');
  
  // Ensure logs directory exists
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().split('T')[0];
  const logFile = path.join(logsDir, `price_sync_${timestamp}.json`);
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    ...results,
    settings: loadConfig()
  };
  
  // Append to daily log
  let logs = [];
  if (fs.existsSync(logFile)) {
    try {
      logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    } catch (e) {
      logs = [];
    }
  }
  
  logs.push(logEntry);
  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
  
  console.log(`[Sync] Log saved to: ${logFile}`);
}

/**
 * Sync single product by Shopify ID
 * @param {string} productId - Shopify product ID
 * @param {string} shopifyStore - Shopify store URL
 * @param {string} shopifyToken - Shopify access token
 * @param {string} cjToken - CJ API token
 * @param {Object} options - Price options
 * @returns {Promise<Object>} Sync result
 */
async function syncSingleProduct(productId, shopifyStore, shopifyToken, cjToken, options = {}) {
  console.log(`[Sync] Syncing single product: ${productId}`);
  
  // Fetch all products and filter (GraphQL doesn't support single product fetch with metafields easily)
  const products = await fetchShopifyProducts(shopifyStore, shopifyToken);
  const product = products.find(p => p.shopifyId === productId || p.graphqlId.includes(productId));
  
  if (!product) {
    return { success: false, error: 'Product not found' };
  }
  
  if (!product.cjProductId) {
    return { success: false, error: 'Product has no CJ ID metafield' };
  }
  
  // Get CJ price
  const { matched } = await matchProducts([product], cjToken);
  
  if (matched.length === 0) {
    return { success: false, error: 'Could not fetch CJ price' };
  }
  
  const matchedProduct = matched[0];
  const { price: newPrice, compareAtPrice } = calculatePrice(matchedProduct.cjPrice, options);
  
  const updateResult = await updateShopifyPrice(
    matchedProduct,
    newPrice,
    compareAtPrice,
    shopifyStore,
    shopifyToken
  );
  
  return {
    success: updateResult.success,
    product: {
      title: matchedProduct.title,
      cjPrice: matchedProduct.cjPrice,
      oldPrice: matchedProduct.currentPrice,
      newPrice,
      compareAtPrice
    },
    error: updateResult.error
  };
}

/**
 * Format preview for console output
 * @param {Object} preview - Preview data
 * @returns {string} Formatted output
 */
function formatPreviewOutput(preview) {
  if (!preview.success) {
    return `Error: ${preview.error}`;
  }
  
  let output = '\n';
  output += 'Price Sync Preview\n';
  output += '==================\n\n';
  output += `Products to update: ${preview.changes.filter(c => c.direction !== 'none').length}\n\n`;
  
  output += 'Product'.padEnd(40) + 'CJ Price'.padEnd(12) + 'Current'.padEnd(12) + 'New Price'.padEnd(12) + 'Change\n';
  output += '-'.repeat(88) + '\n';
  
  for (const change of preview.changes.slice(0, 20)) {
    const title = change.title.length > 38 ? change.title.substring(0, 35) + '...' : change.title;
    const changeStr = change.direction === 'none' ? '-' : 
      (change.direction === 'increase' ? `+€${change.change.toFixed(2)}` : `-€${Math.abs(change.change).toFixed(2)}`);
    
    output += title.padEnd(40);
    output += `€${change.cjPrice.toFixed(2)}`.padEnd(12);
    output += `€${change.currentPrice.toFixed(2)}`.padEnd(12);
    output += `€${change.newPrice.toFixed(2)}`.padEnd(12);
    output += changeStr + '\n';
  }
  
  if (preview.changes.length > 20) {
    output += `\n... and ${preview.changes.length - 20} more products\n`;
  }
  
  output += '\n';
  output += `Total products: ${preview.totalProducts}\n`;
  output += `Matched: ${preview.matchedProducts}\n`;
  output += `Unmatched: ${preview.unmatchedProducts}\n`;
  output += `Price increases: ${preview.summary.increases}\n`;
  output += `Price decreases: ${preview.summary.decreases}\n`;
  output += `No change: ${preview.summary.noChange}\n`;
  
  return output;
}

module.exports = {
  generatePreview,
  executeSync,
  syncSingleProduct,
  updateShopifyPrice,
  formatPreviewOutput
};
