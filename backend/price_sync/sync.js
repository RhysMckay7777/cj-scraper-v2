/**
 * Price Sync Module - Fixed for Render timeout limits
 * 
 * Preview fetches first 20 CJ prices (stays under 30s timeout).
 * Full sync processes all products in batches.
 */

const axios = require('axios');
const path = require('path');

const { calculatePrice, calculateChange, formatPrice, loadConfig } = require('./calculator');

const CJ_API_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

/**
 * Fetch single CJ product price
 */
// Cache CJ prices for 24 hours to avoid burning API quota (1000 req/day limit)
const cjPriceCache = new Map();
const CJ_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

let cjErrorLogged = false;
let cjRateLimited = false;

async function fetchCJPrice(pid, cjToken) {
  // Check cache first
  const cached = cjPriceCache.get(pid);
  if (cached && (Date.now() - cached.ts < CJ_CACHE_TTL)) {
    return cached.price;
  }

  // If we're rate-limited, don't make more requests
  if (cjRateLimited) {
    return null;
  }
  try {
    const response = await axios.get(`${CJ_API_BASE}/product/query`, {
      params: { pid },
      headers: { 'CJ-Access-Token': cjToken },
      timeout: 8000
    });
    if (response.data.result && response.data.data) {
      cjErrorLogged = false;
      const price = parseFloat(response.data.data.sellPrice) || null;
      cjPriceCache.set(pid, { price, ts: Date.now() });
      return price;
    }
    // Check for rate limiting
    if (response.data.code === 1600200 || response.data.message?.includes('Too Many Requests')) {
      console.warn(`[Sync] CJ API rate limited! ${response.data.message}`);
      cjRateLimited = true;
      // Auto-reset after 1 hour (in case it's hourly, not daily)
      setTimeout(() => { cjRateLimited = false; }, 60 * 60 * 1000);
      return null;
    }
    if (!cjErrorLogged) {
      console.warn(`[Sync] CJ API returned no data for ${pid}: code=${response.data.code}, message=${response.data.message}`);
      cjErrorLogged = true;
    }
    cjPriceCache.set(pid, { price: null, ts: Date.now() });
    return null;
  } catch (e) {
    if (e.response?.status === 429) {
      console.warn(`[Sync] CJ API rate limited (HTTP 429)`);
      cjRateLimited = true;
      setTimeout(() => { cjRateLimited = false; }, 60 * 60 * 1000);
      return null;
    }
    if (!cjErrorLogged) {
      console.warn(`[Sync] CJ API error for ${pid}: ${e.message}`);
      cjErrorLogged = true;
    }
    return null;
  }
}

/**
 * Update Shopify product price
 */
async function updateShopifyPrice(product, newPrice, compareAtPrice, shopifyStore, shopifyToken) {
  const cleanStoreUrl = shopifyStore.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const GRAPHQL_ENDPOINT = `https://${cleanStoreUrl}/admin/api/2024-01/graphql.json`;
  
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price compareAtPrice }
        userErrors { field message }
      }
    }
  `;
  
  const productId = product.graphqlId || `gid://shopify/Product/${product.shopifyId}`;
  const variantId = product.variantGraphqlId || `gid://shopify/ProductVariant/${product.variantId}`;
  const variant = { id: variantId, price: newPrice.toFixed(2) };
  if (compareAtPrice !== null) variant.compareAtPrice = compareAtPrice.toFixed(2);
  
  try {
    const response = await axios.post(GRAPHQL_ENDPOINT, {
      query: mutation, variables: { productId, variants: [variant] }
    }, {
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': shopifyToken },
      timeout: 10000
    });
    
    if (response.data.errors?.length > 0) {
      return { success: false, error: response.data.errors.map(e => e.message).join(', ') };
    }
    
    const result = response.data.data?.productVariantsBulkUpdate;
    if (result?.userErrors?.length > 0) {
      return { success: false, error: result.userErrors.map(e => e.message).join(', ') };
    }
    const updated = result?.productVariants?.[0];
    return {
      success: true,
      newPrice: parseFloat(updated?.price || newPrice),
      newCompareAtPrice: updated?.compareAtPrice ? parseFloat(updated.compareAtPrice) : null
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Generate preview - fast version that stays under Render's 30s timeout
 * Fetches Shopify products, then samples first 20 for CJ price lookup
 */
async function generatePreview(shopifyStore, shopifyToken, cjToken, options = {}) {
  console.log('[Sync] Generating price sync preview...');
  
  const { fetchShopifyProducts } = require('./matcher');
  
  // Phase 1: Fetch all Shopify products (~5 seconds for 500 products)
  const shopifyProducts = await fetchShopifyProducts(shopifyStore, shopifyToken);
  
  if (shopifyProducts.length === 0) {
    return { success: false, error: 'No products found in Shopify store' };
  }
  
  const withCjId = shopifyProducts.filter(p => p.cjProductId);
  const withoutCjId = shopifyProducts.filter(p => !p.cjProductId);
  
  console.log(`[Sync] ${shopifyProducts.length} products, ${withCjId.length} with CJ ID, ${withoutCjId.length} without`);
  
  // Phase 2: Fetch CJ prices for first 20 only (preview - ~8 seconds)
  const PREVIEW_LIMIT = 20;
  const toFetch = withCjId.slice(0, PREVIEW_LIMIT);
  const config = loadConfig();
  const effectiveOptions = options.markup_multiplier ? options : config;
  
  console.log(`[Sync] Fetching CJ prices for ${toFetch.length} products (preview)...`);
  
  const products = [];
  let increases = 0, decreases = 0, noChange = 0, missing = 0;
  
  for (const product of toFetch) {
    const cjPrice = await fetchCJPrice(product.cjProductId, cjToken);
    
    if (cjPrice !== null) {
      const { price: newPrice, compareAtPrice } = calculatePrice(cjPrice, effectiveOptions);
      const { change, changePercent, direction } = calculateChange(product.currentPrice, newPrice);
      
      if (direction === 'increase') increases++;
      else if (direction === 'decrease') decreases++;
      else noChange++;
      
      products.push({
        shopifyId: product.shopifyId,
        title: product.title,
        cjProductId: product.cjProductId,
        cjPrice,
        currentPrice: product.currentPrice,
        newPrice,
        compareAtPrice,
        change,
        changePercent,
        direction,
        matchMethod: 'metafield'
      });
    } else {
      missing++;
      products.push({
        shopifyId: product.shopifyId,
        title: product.title,
        cjProductId: product.cjProductId,
        cjPrice: null,
        currentPrice: product.currentPrice,
        newPrice: null,
        direction: 'unknown',
        matchMethod: 'metafield'
      });
    }
    
    await new Promise(r => setTimeout(r, 300));
  }
  
  return {
    success: true,
    totalProducts: shopifyProducts.length,
    matchedProducts: withCjId.length,
    unmatchedProducts: withoutCjId.length,
    previewLimit: PREVIEW_LIMIT,
    showingPreview: toFetch.length,
    products,
    summary: { increases, decreases, noChange, missing },
    unmatched: withoutCjId.slice(0, 10).map(p => ({
      title: p.title, shopifyId: p.shopifyId, reason: 'No CJ Product ID'
    }))
  };
}

/**
 * Execute full sync - processes ALL products
 */
async function executeSync(shopifyStore, shopifyToken, cjToken, options = {}) {
  console.log('[Sync] Starting full price sync...');
  
  const { fetchShopifyProducts } = require('./matcher');
  const shopifyProducts = await fetchShopifyProducts(shopifyStore, shopifyToken);
  const withCjId = shopifyProducts.filter(p => p.cjProductId);
  const config = loadConfig();
  const effectiveOptions = options.markup_multiplier ? options : config;
  
  console.log(`[Sync] Syncing ${withCjId.length} products with CJ IDs...`);
  
  const results = { success: 0, failed: 0, skipped: 0, errors: [] };
  const productIds = options.productIds ? new Set(options.productIds) : null;
  
  for (const product of withCjId) {
    // Skip if specific products requested and this isn't one
    if (productIds && !productIds.has(product.shopifyId)) {
      results.skipped++;
      continue;
    }
    
    const cjPrice = await fetchCJPrice(product.cjProductId, cjToken);
    
    if (cjPrice === null) {
      results.failed++;
      results.errors.push({ title: product.title, error: 'CJ price not found' });
      continue;
    }
    
    const { price: newPrice, compareAtPrice } = calculatePrice(cjPrice, effectiveOptions);
    
    // Skip if price hasn't changed
    if (Math.abs(newPrice - product.currentPrice) < 0.01) {
      results.skipped++;
      continue;
    }
    
    const updateResult = await updateShopifyPrice(product, newPrice, compareAtPrice, shopifyStore, shopifyToken);
    
    if (updateResult.success) {
      results.success++;
    } else {
      results.failed++;
      results.errors.push({ title: product.title, error: updateResult.error });
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`[Sync] Complete: ${results.success} updated, ${results.failed} failed, ${results.skipped} skipped`);
  
  return {
    success: true,
    ...results,
    total: withCjId.length
  };
}

async function syncSingleProduct(productId, shopifyStore, shopifyToken, cjToken, options = {}) {
  return executeSync(shopifyStore, shopifyToken, cjToken, { ...options, productIds: [productId] });
}

function formatPreviewOutput(preview) {
  return preview;
}

module.exports = {
  generatePreview,
  executeSync,
  syncSingleProduct,
  formatPreviewOutput,
  updateShopifyPrice,
  fetchCJPrice
};
