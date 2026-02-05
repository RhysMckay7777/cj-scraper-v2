/**
 * Product Matcher Module
 * 
 * Matches Shopify products to CJ products using:
 * 1. CJ Product ID stored in metafield (preferred)
 * 2. SKU field
 * 3. Fuzzy title matching (fallback)
 */

const axios = require('axios');

const CJ_API_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const CJ_METAFIELD_NAMESPACE = 'custom';
const CJ_METAFIELD_KEY = 'cj_product_id';

/**
 * Fetch all products from Shopify with metafields
 * @param {string} shopifyStore - Shopify store URL
 * @param {string} shopifyToken - Shopify access token
 * @returns {Promise<Array>} Array of products
 */
async function fetchShopifyProducts(shopifyStore, shopifyToken) {
  const cleanStoreUrl = shopifyStore.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const GRAPHQL_ENDPOINT = `https://${cleanStoreUrl}/admin/api/2024-01/graphql.json`;
  
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  
  console.log('[Matcher] Fetching Shopify products...');
  
  while (hasNextPage) {
    const query = `
      query GetProducts($cursor: String) {
        products(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              handle
              status
              variants(first: 1) {
                edges {
                  node {
                    id
                    sku
                    price
                    compareAtPrice
                  }
                }
              }
              metafields(first: 10, namespace: "${CJ_METAFIELD_NAMESPACE}") {
                edges {
                  node {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    try {
      const response = await axios.post(GRAPHQL_ENDPOINT, {
        query,
        variables: { cursor }
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': shopifyToken
        },
        timeout: 30000
      });
      
      const data = response.data.data?.products;
      if (!data) {
        console.error('[Matcher] No products data in response');
        break;
      }
      
      const products = data.edges.map(edge => {
        const node = edge.node;
        const variant = node.variants.edges[0]?.node || {};
        const metafields = node.metafields.edges.reduce((acc, mf) => {
          acc[mf.node.key] = mf.node.value;
          return acc;
        }, {});
        
        return {
          shopifyId: node.id.split('/').pop(),
          graphqlId: node.id,
          title: node.title,
          handle: node.handle,
          status: node.status,
          variantId: variant.id?.split('/').pop(),
          variantGraphqlId: variant.id,
          sku: variant.sku || null,
          currentPrice: parseFloat(variant.price) || 0,
          currentCompareAtPrice: variant.compareAtPrice ? parseFloat(variant.compareAtPrice) : null,
          cjProductId: metafields[CJ_METAFIELD_KEY] || null
        };
      });
      
      allProducts = allProducts.concat(products);
      hasNextPage = data.pageInfo.hasNextPage;
      cursor = data.pageInfo.endCursor;
      
      console.log(`[Matcher] Fetched ${allProducts.length} products...`);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
      
    } catch (error) {
      console.error('[Matcher] Error fetching products:', error.message, 'Status:', error.response?.status, 'URL:', error.config?.url);
      throw new Error(`Shopify API error: ${error.message} (store: ${shopifyStore})`);
    }
  }
  
  console.log(`[Matcher] Total products fetched: ${allProducts.length}`);
  return allProducts;
}

/**
 * Fetch CJ product details by ID
 * @param {string} cjProductId - CJ product ID
 * @param {string} cjToken - CJ API token
 * @returns {Promise<Object|null>} CJ product or null
 */
async function fetchCJProduct(cjProductId, cjToken) {
  try {
    const response = await axios.get(`${CJ_API_BASE}/product/query`, {
      params: { pid: cjProductId },
      headers: { 'CJ-Access-Token': cjToken },
      timeout: 10000
    });
    
    if (response.data.result && response.data.data) {
      return response.data.data;
    }
    return null;
  } catch (error) {
    console.error(`[Matcher] Error fetching CJ product ${cjProductId}:`, error.message);
    return null;
  }
}

/**
 * Fetch CJ product prices in batch
 * @param {Array<string>} productIds - Array of CJ product IDs
 * @param {string} cjToken - CJ API token
 * @returns {Promise<Map>} Map of productId -> price
 */
async function fetchCJPricesBatch(productIds, cjToken) {
  const priceMap = new Map();
  
  console.log(`[Matcher] Fetching prices for ${productIds.length} CJ products...`);
  
  // CJ API doesn't have batch endpoint, fetch individually with rate limiting
  for (const pid of productIds) {
    try {
      const product = await fetchCJProduct(pid, cjToken);
      if (product && product.sellPrice) {
        priceMap.set(pid, parseFloat(product.sellPrice));
      }
      // Rate limiting - CJ API is sensitive
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.warn(`[Matcher] Failed to fetch price for ${pid}`);
    }
  }
  
  console.log(`[Matcher] Got prices for ${priceMap.size}/${productIds.length} products`);
  return priceMap;
}

/**
 * Search CJ products by keyword (for title matching fallback)
 * @param {string} keyword - Search keyword
 * @param {string} cjToken - CJ API token
 * @returns {Promise<Array>} Array of CJ products
 */
async function searchCJProducts(keyword, cjToken) {
  try {
    const response = await axios.get(`${CJ_API_BASE}/product/list`, {
      params: {
        productNameEn: keyword,
        pageNum: 1,
        pageSize: 20
      },
      headers: { 'CJ-Access-Token': cjToken },
      timeout: 15000
    });
    
    if (response.data.result && response.data.data?.list) {
      return response.data.data.list;
    }
    return [];
  } catch (error) {
    console.error(`[Matcher] Error searching CJ products:`, error.message);
    return [];
  }
}

/**
 * Fuzzy match title similarity (Levenshtein-based)
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity score 0-1
 */
function titleSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  if (s1 === s2) return 1;
  
  // Simple word overlap for faster matching
  const words1 = new Set(s1.split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(s2.split(/\s+/).filter(w => w.length > 2));
  
  let matches = 0;
  for (const word of words1) {
    if (words2.has(word)) matches++;
  }
  
  const totalWords = Math.max(words1.size, words2.size);
  return totalWords > 0 ? matches / totalWords : 0;
}

/**
 * Match Shopify products to CJ products
 * @param {Array} shopifyProducts - Shopify products
 * @param {string} cjToken - CJ API token
 * @returns {Promise<Array>} Matched products with CJ data
 */
async function matchProducts(shopifyProducts, cjToken) {
  const matched = [];
  const unmatched = [];
  
  // Separate products by matching method
  const withCjId = shopifyProducts.filter(p => p.cjProductId);
  const withSku = shopifyProducts.filter(p => !p.cjProductId && p.sku);
  const needsTitleMatch = shopifyProducts.filter(p => !p.cjProductId && !p.sku);
  
  console.log(`[Matcher] Products breakdown:`);
  console.log(`  - With CJ ID metafield: ${withCjId.length}`);
  console.log(`  - With SKU (no CJ ID): ${withSku.length}`);
  console.log(`  - Needs title matching: ${needsTitleMatch.length}`);
  
  // Match by CJ Product ID (most reliable)
  if (withCjId.length > 0) {
    const cjIds = withCjId.map(p => p.cjProductId);
    const prices = await fetchCJPricesBatch(cjIds, cjToken);
    
    for (const product of withCjId) {
      const cjPrice = prices.get(product.cjProductId);
      if (cjPrice !== undefined) {
        matched.push({
          ...product,
          cjPrice,
          matchMethod: 'metafield'
        });
      } else {
        unmatched.push({ ...product, reason: 'CJ product not found' });
      }
    }
  }
  
  // Match by SKU (if SKU contains CJ product ID)
  for (const product of withSku) {
    // Try SKU as CJ product ID
    const cjProduct = await fetchCJProduct(product.sku, cjToken);
    if (cjProduct && cjProduct.sellPrice) {
      matched.push({
        ...product,
        cjProductId: product.sku,
        cjPrice: parseFloat(cjProduct.sellPrice),
        matchMethod: 'sku'
      });
    } else {
      unmatched.push({ ...product, reason: 'SKU not a valid CJ ID' });
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  // Title matching is slow and unreliable - skip for now
  // Could be added as optional feature later
  for (const product of needsTitleMatch) {
    unmatched.push({ ...product, reason: 'No CJ ID or SKU - title matching disabled' });
  }
  
  console.log(`[Matcher] Matching complete:`);
  console.log(`  - Matched: ${matched.length}`);
  console.log(`  - Unmatched: ${unmatched.length}`);
  
  return { matched, unmatched };
}

/**
 * Add CJ Product ID metafield to Shopify product
 * @param {string} productId - Shopify product GraphQL ID
 * @param {string} cjProductId - CJ product ID
 * @param {string} shopifyStore - Shopify store URL
 * @param {string} shopifyToken - Shopify access token
 * @returns {Promise<boolean>} Success
 */
async function setCJMetafield(productId, cjProductId, shopifyStore, shopifyToken) {
  const cleanStoreUrl = shopifyStore.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const GRAPHQL_ENDPOINT = `https://${cleanStoreUrl}/admin/api/2024-01/graphql.json`;
  
  const mutation = `
    mutation SetCJMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  
  // Ensure product ID is in GraphQL format
  const graphqlProductId = productId.startsWith('gid://')
    ? productId
    : `gid://shopify/Product/${productId}`;
  
  try {
    const response = await axios.post(GRAPHQL_ENDPOINT, {
      query: mutation,
      variables: {
        metafields: [{
          ownerId: graphqlProductId,
          namespace: CJ_METAFIELD_NAMESPACE,
          key: CJ_METAFIELD_KEY,
          value: cjProductId,
          type: 'single_line_text_field'
        }]
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': shopifyToken
      },
      timeout: 10000
    });
    
    const result = response.data.data?.metafieldsSet;
    if (result?.userErrors?.length > 0) {
      console.error('[Matcher] Metafield error:', result.userErrors);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[Matcher] Error setting metafield:', error.message);
    return false;
  }
}

module.exports = {
  fetchShopifyProducts,
  fetchCJProduct,
  fetchCJPricesBatch,
  searchCJProducts,
  matchProducts,
  setCJMetafield,
  titleSimilarity,
  CJ_METAFIELD_NAMESPACE,
  CJ_METAFIELD_KEY
};
