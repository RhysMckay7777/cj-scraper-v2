/**
 * Price Sync Module
 * 
 * Export all price sync functionality
 */

const { generatePreview, executeSync, syncSingleProduct, formatPreviewOutput } = require('./sync');
const { calculatePrice, calculateChange, formatPrice, loadConfig } = require('./calculator');
const { fetchShopifyProducts, matchProducts, setCJMetafield } = require('./matcher');

module.exports = {
  // Main sync functions
  generatePreview,
  executeSync,
  syncSingleProduct,
  formatPreviewOutput,
  
  // Price calculation
  calculatePrice,
  calculateChange,
  formatPrice,
  loadConfig,
  
  // Matching
  fetchShopifyProducts,
  matchProducts,
  setCJMetafield
};
