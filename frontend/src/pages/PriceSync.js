import React, { useState } from 'react';
import { 
  RefreshCw, 
  Search, 
  TrendingUp, 
  TrendingDown, 
  Minus,
  AlertCircle,
  CheckCircle,
  Package,
  DollarSign,
  ArrowRight
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { getApiUrl, getCredentials } from '../utils/api';

function PriceSync() {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncResults, setSyncResults] = useState(null);
  const [error, setError] = useState(null);
  const [selectedProducts, setSelectedProducts] = useState(new Set());
  const [selectAll, setSelectAll] = useState(true);

  const creds = getCredentials();
  const hasCredentials = creds.shopifyStore && creds.shopifyToken;

  const fetchPreview = async () => {
    if (!hasCredentials) {
      setError('Please configure your Shopify credentials in Settings');
      return;
    }

    setLoading(true);
    setError(null);
    setPreview(null);
    setSyncResults(null);

    try {
      const response = await fetch(`${getApiUrl()}/api/sync-prices/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopifyStore: creds.shopifyStore,
          shopifyToken: creds.shopifyToken
        })
      });

      const data = await response.json();
      
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to fetch preview');
      }

      setPreview(data);
      // Select all products by default
      const allIds = new Set(data.products?.map(p => p.shopifyId) || []);
      setSelectedProducts(allIds);
      setSelectAll(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const executeSync = async () => {
    if (!hasCredentials || selectedProducts.size === 0) return;

    setSyncing(true);
    setSyncProgress(0);
    setError(null);
    setSyncResults(null);

    try {
      // Get only selected product IDs
      const productIds = Array.from(selectedProducts);
      
      const response = await fetch(`${getApiUrl()}/api/sync-prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopifyStore: creds.shopifyStore,
          shopifyToken: creds.shopifyToken,
          options: {
            productIds: productIds.length < preview?.products?.length ? productIds : undefined
          }
        })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Sync failed');
      }

      setSyncResults(data);
      setSyncProgress(100);

      // Save to localStorage for dashboard
      localStorage.setItem('lastSyncTime', new Date().toISOString());
      localStorage.setItem('lastSyncResults', JSON.stringify({
        total: data.summary?.total || 0,
        updated: data.summary?.updated || 0,
        noChange: data.summary?.skipped || 0,
        errors: data.summary?.errors || 0
      }));

      // Save to history
      const history = JSON.parse(localStorage.getItem('syncHistory') || '[]');
      history.unshift({
        timestamp: new Date().toISOString(),
        summary: data.summary,
        products: data.results?.slice(0, 50) // Keep first 50 for details
      });
      localStorage.setItem('syncHistory', JSON.stringify(history.slice(0, 20))); // Keep last 20

    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const toggleProduct = (id) => {
    const newSelected = new Set(selectedProducts);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedProducts(newSelected);
    setSelectAll(newSelected.size === preview?.products?.length);
  };

  const toggleSelectAll = () => {
    if (selectAll) {
      setSelectedProducts(new Set());
    } else {
      setSelectedProducts(new Set(preview?.products?.map(p => p.shopifyId) || []));
    }
    setSelectAll(!selectAll);
  };

  const formatPrice = (price) => {
    if (price === null || price === undefined) return '-';
    return `$${parseFloat(price).toFixed(2)}`;
  };

  const getChangeInfo = (product) => {
    if (!product.currentPrice || !product.newPrice) return { icon: Minus, color: 'text-slate-400', text: '-' };
    
    const diff = product.newPrice - product.currentPrice;
    if (Math.abs(diff) < 0.01) {
      return { icon: Minus, color: 'text-slate-400', text: 'No change' };
    }
    if (diff > 0) {
      return { icon: TrendingUp, color: 'text-emerald-400', text: `+${formatPrice(diff)}` };
    }
    return { icon: TrendingDown, color: 'text-red-400', text: formatPrice(diff) };
  };

  // Stats from preview
  const stats = preview ? {
    total: preview.products?.length || 0,
    increases: preview.products?.filter(p => p.newPrice > p.currentPrice).length || 0,
    decreases: preview.products?.filter(p => p.newPrice < p.currentPrice).length || 0,
    noChange: preview.products?.filter(p => Math.abs((p.newPrice || 0) - (p.currentPrice || 0)) < 0.01).length || 0,
    missing: preview.products?.filter(p => !p.cjPrice).length || 0
  } : null;

  if (!hasCredentials) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold mb-6">Price Sync</h1>
        <div className="bg-amber-500/20 border border-amber-500/30 rounded-xl p-6">
          <div className="flex items-start gap-4">
            <AlertCircle className="text-amber-400 flex-shrink-0" size={24} />
            <div>
              <h3 className="font-semibold text-amber-400">Shopify Not Connected</h3>
              <p className="text-slate-300 mt-1">
                Please configure your Shopify store credentials before using Price Sync.
              </p>
              <Link 
                to="/settings" 
                className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-amber-500 text-black font-medium rounded-lg hover:bg-amber-400 transition"
              >
                Go to Settings <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold">Price Sync</h1>
          <p className="text-slate-400 mt-1">
            Sync Shopify prices with current CJ costs
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={fetchPreview}
            disabled={loading || syncing}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg transition"
          >
            <Search size={18} className={loading ? 'animate-pulse' : ''} />
            {loading ? 'Loading...' : 'Preview Changes'}
          </button>
          {preview && !syncResults && (
            <button
              onClick={executeSync}
              disabled={syncing || selectedProducts.size === 0}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 rounded-lg transition font-medium"
            >
              <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing...' : `Sync ${selectedProducts.size} Products`}
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/20 border border-red-500/30 rounded-xl p-4 flex items-center gap-3 text-red-400">
          <AlertCircle size={20} />
          {error}
        </div>
      )}

      {/* Progress Bar */}
      {syncing && (
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-slate-400">Syncing prices...</span>
            <span className="text-sm font-medium">{syncProgress}%</span>
          </div>
          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
            <div 
              className="h-full bg-emerald-500 transition-all duration-300 animate-pulse"
              style={{ width: syncing ? '100%' : `${syncProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Sync Results */}
      {syncResults && (
        <div className="bg-emerald-500/20 border border-emerald-500/30 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle className="text-emerald-400" size={24} />
            <h2 className="text-lg font-semibold text-emerald-400">Sync Complete!</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-slate-800/50 rounded-lg p-4">
              <p className="text-2xl font-bold">{syncResults.summary?.total || 0}</p>
              <p className="text-sm text-slate-400">Total Processed</p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4">
              <p className="text-2xl font-bold text-emerald-400">{syncResults.summary?.updated || 0}</p>
              <p className="text-sm text-slate-400">Updated</p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4">
              <p className="text-2xl font-bold text-blue-400">{syncResults.summary?.skipped || 0}</p>
              <p className="text-sm text-slate-400">Skipped</p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-4">
              <p className="text-2xl font-bold text-red-400">{syncResults.summary?.errors || 0}</p>
              <p className="text-sm text-slate-400">Errors</p>
            </div>
          </div>
          <button
            onClick={() => {
              setSyncResults(null);
              setPreview(null);
            }}
            className="mt-4 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
          >
            Start New Sync
          </button>
        </div>
      )}

      {/* Stats Summary */}
      {stats && !syncResults && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
            <div className="flex items-center gap-2 text-slate-400 mb-1">
              <Package size={16} />
              <span className="text-sm">Total</span>
            </div>
            <p className="text-2xl font-bold">{stats.total}</p>
          </div>
          <div className="bg-slate-800 rounded-xl p-4 border border-emerald-500/30">
            <div className="flex items-center gap-2 text-emerald-400 mb-1">
              <TrendingUp size={16} />
              <span className="text-sm">Increases</span>
            </div>
            <p className="text-2xl font-bold text-emerald-400">{stats.increases}</p>
          </div>
          <div className="bg-slate-800 rounded-xl p-4 border border-red-500/30">
            <div className="flex items-center gap-2 text-red-400 mb-1">
              <TrendingDown size={16} />
              <span className="text-sm">Decreases</span>
            </div>
            <p className="text-2xl font-bold text-red-400">{stats.decreases}</p>
          </div>
          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
            <div className="flex items-center gap-2 text-slate-400 mb-1">
              <Minus size={16} />
              <span className="text-sm">No Change</span>
            </div>
            <p className="text-2xl font-bold">{stats.noChange}</p>
          </div>
          <div className="bg-slate-800 rounded-xl p-4 border border-amber-500/30">
            <div className="flex items-center gap-2 text-amber-400 mb-1">
              <AlertCircle size={16} />
              <span className="text-sm">Missing CJ</span>
            </div>
            <p className="text-2xl font-bold text-amber-400">{stats.missing}</p>
          </div>
        </div>
      )}

      {/* Product Table */}
      {preview?.products && preview.products.length > 0 && !syncResults && (
        <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-700/50">
                <tr>
                  <th className="px-4 py-3 text-left">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectAll}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 rounded border-slate-500 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-800"
                      />
                      <span className="text-sm font-medium">All</span>
                    </label>
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-slate-300">Product</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-slate-300">CJ Price</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-slate-300">Current</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-slate-300">New Price</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-slate-300">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {preview.products.map((product) => {
                  const change = getChangeInfo(product);
                  const ChangeIcon = change.icon;
                  
                  return (
                    <tr 
                      key={product.shopifyId} 
                      className={`hover:bg-slate-700/30 transition ${
                        !selectedProducts.has(product.shopifyId) ? 'opacity-50' : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedProducts.has(product.shopifyId)}
                          onChange={() => toggleProduct(product.shopifyId)}
                          className="w-4 h-4 rounded border-slate-500 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-800"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {product.image && (
                            <img 
                              src={product.image} 
                              alt=""
                              className="w-10 h-10 rounded object-cover bg-slate-700"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="font-medium truncate max-w-xs">{product.title}</p>
                            {!product.cjProductId && (
                              <p className="text-xs text-amber-400">No CJ ID linked</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {product.cjPrice ? (
                          <span className="text-blue-400">{formatPrice(product.cjPrice)}</span>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {formatPrice(product.currentPrice)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-medium">
                        {product.newPrice ? (
                          <span className="text-white">{formatPrice(product.newPrice)}</span>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`flex items-center justify-end gap-1 ${change.color}`}>
                          <ChangeIcon size={14} />
                          {change.text}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!preview && !loading && !error && (
        <div className="bg-slate-800 rounded-xl p-12 border border-slate-700 text-center">
          <DollarSign className="mx-auto text-slate-600 mb-4" size={48} />
          <h2 className="text-xl font-semibold mb-2">Ready to Sync Prices</h2>
          <p className="text-slate-400 mb-6 max-w-md mx-auto">
            Click "Preview Changes" to see how your Shopify prices compare to current CJ costs
          </p>
          <button
            onClick={fetchPreview}
            className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-500 hover:bg-emerald-600 rounded-lg transition font-medium"
          >
            <Search size={18} />
            Preview Changes
          </button>
        </div>
      )}
    </div>
  );
}

export default PriceSync;
