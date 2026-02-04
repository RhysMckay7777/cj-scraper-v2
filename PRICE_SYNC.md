# Price Sync Feature

Automatically sync CJ Dropshipping prices to your Shopify store with configurable markup.

## Features

- **Preview Mode**: See all price changes before applying
- **Batch Sync**: Update all products at once
- **Single Product Sync**: Update individual products
- **Configurable Pricing**:
  - Markup multiplier (default: 2x)
  - Minimum price floor
  - Maximum price ceiling
  - Price rounding (e.g., X.95, X.99)
  - Compare-at price for sale display

## How It Works

### Product Matching

Products are matched between Shopify and CJ using:

1. **CJ Product ID in Metafield** (most reliable)
   - Stored in `custom.cj_product_id` metafield
   - Automatically set when uploading new products

2. **SKU Field** (fallback)
   - If SKU matches a CJ product ID

### Price Calculation

```
shopify_price = cj_price × markup_multiplier
```

Additional settings:
- `min_price`: Floor price (e.g., €19.99)
- `max_price`: Ceiling price (optional)
- `round_to`: Price ending (e.g., 0.95 → €24.95)
- `compare_at_markup`: For "was/now" pricing (e.g., 1.3 = 30% higher)

## API Endpoints

### Preview Price Changes

```bash
POST /api/sync-prices/preview
Content-Type: application/json

{
  "shopifyStore": "your-store.myshopify.com",
  "shopifyToken": "shpat_xxxxx",
  "options": {
    "markup_multiplier": 2.0,
    "min_price": 19.99,
    "round_to": 0.95,
    "show_compare_at": false
  }
}
```

Response:
```json
{
  "success": true,
  "totalProducts": 150,
  "matchedProducts": 120,
  "unmatchedProducts": 30,
  "changes": [
    {
      "shopifyId": "123456",
      "title": "Cozy Knit Cardigan",
      "cjPrice": 12.50,
      "currentPrice": 24.95,
      "newPrice": 24.95,
      "change": 0,
      "direction": "none"
    }
  ],
  "summary": {
    "increases": 15,
    "decreases": 5,
    "noChange": 100
  }
}
```

### Execute Price Sync

```bash
POST /api/sync-prices
Content-Type: application/json

{
  "shopifyStore": "your-store.myshopify.com",
  "shopifyToken": "shpat_xxxxx",
  "options": {}
}
```

Response:
```json
{
  "success": true,
  "updated": 20,
  "failed": 0,
  "skipped": 100,
  "duration": 45,
  "changes": [...]
}
```

### Sync Single Product

```bash
POST /api/sync-prices/product/123456
Content-Type: application/json

{
  "shopifyStore": "your-store.myshopify.com",
  "shopifyToken": "shpat_xxxxx",
  "options": {
    "markup_multiplier": 2.5
  }
}
```

### Set CJ Metafield on Existing Product

For products uploaded before this feature, manually link them:

```bash
POST /api/set-cj-metafield
Content-Type: application/json

{
  "productId": "123456",
  "cjProductId": "CJ-PROD-ID-HERE",
  "shopifyStore": "your-store.myshopify.com",
  "shopifyToken": "shpat_xxxxx"
}
```

### Get/Update Config

```bash
# Get config
GET /api/sync-prices/config

# Update config
POST /api/sync-prices/config
Content-Type: application/json

{
  "config": {
    "markup_multiplier": 2.0,
    "min_price": 19.99,
    "max_price": null,
    "round_to": 0.95,
    "show_compare_at": false,
    "compare_at_markup": 1.3
  }
}
```

## Configuration

Edit `backend/config/price_sync_config.json`:

```json
{
  "markup_multiplier": 2.0,
  "min_price": 19.99,
  "max_price": null,
  "round_to": 0.95,
  "show_compare_at": false,
  "compare_at_markup": 1.3,
  "auto_sync_enabled": false,
  "auto_sync_schedule": "daily",
  "batch_size": 50,
  "rate_limit_delay_ms": 500
}
```

## Logs

Sync logs are saved to `backend/logs/price_sync_YYYY-MM-DD.json`

Example:
```json
{
  "timestamp": "2026-02-04T15:30:00Z",
  "updated": 47,
  "failed": 0,
  "skipped": 103,
  "duration": 23,
  "settings": { ... },
  "changes": [ ... ]
}
```

## New Products

New products uploaded via `/api/upload-shopify` now automatically include:

1. CJ Product ID stored in `custom.cj_product_id` metafield
2. CJ Product ID as SKU fallback

This ensures all new products can be price-synced.

## Backfilling Existing Products

For products uploaded before this feature, use the `/api/set-cj-metafield` endpoint to manually link them, or:

1. Export your Shopify products
2. Match titles to CJ products
3. Use the API to set metafields in batch

## Environment Variables

Required:
- `CJ_API_TOKEN` - Your CJ Dropshipping API token

The Shopify credentials are passed per-request for flexibility with multiple stores.
