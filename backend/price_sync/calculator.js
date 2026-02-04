/**
 * Price Calculator Module
 * 
 * Handles price calculations with markup, rounding, and compare-at prices.
 */

const fs = require('fs');
const path = require('path');

// Load config
const CONFIG_PATH = path.join(__dirname, '../config/price_sync_config.json');

function loadConfig() {
  try {
    const configData = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    console.warn('[Calculator] Config not found, using defaults');
    return {
      markup_multiplier: 2.0,
      min_price: 19.99,
      max_price: null,
      round_to: 0.95,
      show_compare_at: false,
      compare_at_markup: 1.3
    };
  }
}

/**
 * Round price to a specific ending (e.g., X.95 or X.99)
 * @param {number} price - Price to round
 * @param {number} ending - Decimal ending (e.g., 0.95, 0.99)
 * @returns {number} Rounded price
 */
function roundToEnding(price, ending = 0.95) {
  const whole = Math.floor(price);
  const decimal = price - whole;
  
  // If decimal is already close to ending, keep it
  if (Math.abs(decimal - ending) < 0.1) {
    return whole + ending;
  }
  
  // Round to nearest whole + ending
  if (decimal >= 0.5) {
    return whole + 1 + ending;
  } else {
    return whole + ending;
  }
}

/**
 * Calculate Shopify price from CJ price
 * @param {number} cjPrice - Original CJ price
 * @param {Object} options - Override options
 * @returns {Object} { price, compareAtPrice }
 */
function calculatePrice(cjPrice, options = {}) {
  const config = loadConfig();
  
  const markup = options.markup_multiplier || config.markup_multiplier;
  const minPrice = options.min_price ?? config.min_price;
  const maxPrice = options.max_price ?? config.max_price;
  const roundTo = options.round_to ?? config.round_to;
  const showCompareAt = options.show_compare_at ?? config.show_compare_at;
  const compareAtMarkup = options.compare_at_markup ?? config.compare_at_markup;
  
  // Calculate base price with markup
  let calculatedPrice = cjPrice * markup;
  
  // Round to ending
  if (roundTo) {
    calculatedPrice = roundToEnding(calculatedPrice, roundTo);
  }
  
  // Apply floor (minimum price)
  if (minPrice && calculatedPrice < minPrice) {
    calculatedPrice = minPrice;
  }
  
  // Apply ceiling (maximum price)
  if (maxPrice && calculatedPrice > maxPrice) {
    calculatedPrice = maxPrice;
  }
  
  // Calculate compare-at price if enabled
  let compareAtPrice = null;
  if (showCompareAt) {
    compareAtPrice = calculatedPrice * compareAtMarkup;
    if (roundTo) {
      compareAtPrice = roundToEnding(compareAtPrice, roundTo);
    }
  }
  
  return {
    price: parseFloat(calculatedPrice.toFixed(2)),
    compareAtPrice: compareAtPrice ? parseFloat(compareAtPrice.toFixed(2)) : null
  };
}

/**
 * Format price for display
 * @param {number} price - Price to format
 * @param {string} currency - Currency symbol (default: €)
 * @returns {string} Formatted price
 */
function formatPrice(price, currency = '€') {
  return `${currency}${price.toFixed(2)}`;
}

/**
 * Calculate price change
 * @param {number} oldPrice - Current Shopify price
 * @param {number} newPrice - New calculated price
 * @returns {Object} { change, changePercent, direction }
 */
function calculateChange(oldPrice, newPrice) {
  const change = newPrice - oldPrice;
  const changePercent = oldPrice > 0 ? (change / oldPrice) * 100 : 0;
  
  let direction = 'none';
  if (change > 0.01) direction = 'increase';
  else if (change < -0.01) direction = 'decrease';
  
  return {
    change: parseFloat(change.toFixed(2)),
    changePercent: parseFloat(changePercent.toFixed(1)),
    direction
  };
}

module.exports = {
  loadConfig,
  roundToEnding,
  calculatePrice,
  formatPrice,
  calculateChange
};
