import React, { useState, useEffect } from 'react';
import { 
  CheckCircle, 
  XCircle, 
  RefreshCw, 
  Package, 
  Clock,
  TrendingUp,
  AlertCircle,
  ArrowRight
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { getApiUrl, getCredentials } from '../utils/api';

function Dashboard() {
  const [status, setStatus] = useState({
    shopify: 'checking',
    cj: 'checking',
    lastSync: null,
    stats: null
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkConnections();
  }, []);

  const checkConnections = async () => {
    setLoading(true);
    const creds = getCredentials();
    
    // Check Shopify connection via backend proxy (avoids CORS)
    let shopifyStatus = 'disconnected';
    let stats = null;
    
    if (creds.shopifyStore && creds.shopifyToken) {
      try {
        // Use backend proxy to test connection
        const response = await fetch(`${getApiUrl()}/api/test-connection`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            shopifyStore: creds.shopifyStore,
            shopifyToken: creds.shopifyToken
          })
        });
        
        const data = await response.json();
        
        if (data.success) {
          shopifyStatus = 'connected';
          
          // Get product count via preview endpoint (it returns counts)
          try {
            const previewResp = await fetch(`${getApiUrl()}/api/sync-prices/preview`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                shopifyStore: creds.shopifyStore,
                shopifyToken: creds.shopifyToken
              })
            });
            const previewData = await previewResp.json();
            if (previewData.success) {
              stats = { totalProducts: previewData.totalProducts || 0 };
            }
          } catch (e) {
            // Ignore count errors, connection still works
          }
        }
      } catch (e) {
        shopifyStatus = 'error';
      }
    }

    // Check CJ/Server connection
    let cjStatus = 'disconnected';
    try {
      const response = await fetch(`${getApiUrl()}/health`);
      if (response.ok) {
        cjStatus = 'connected';
      }
    } catch (e) {
      cjStatus = 'error';
    }

    // Get last sync from localStorage
    const lastSync = localStorage.getItem('lastSyncTime');
    const lastSyncResults = localStorage.getItem('lastSyncResults');

    setStatus({
      shopify: shopifyStatus,
      cj: cjStatus,
      lastSync: lastSync ? new Date(lastSync).toLocaleString() : null,
      lastSyncResults: lastSyncResults ? JSON.parse(lastSyncResults) : null,
      stats
    });
    setLoading(false);
  };

  const StatusBadge = ({ status: s }) => {
    const configs = {
      connected: { icon: CheckCircle, text: 'Connected', color: 'text-emerald-400' },
      disconnected: { icon: XCircle, text: 'Not Connected', color: 'text-slate-400' },
      checking: { icon: RefreshCw, text: 'Checking...', color: 'text-blue-400' },
      error: { icon: AlertCircle, text: 'Error', color: 'text-red-400' }
    };
    const config = configs[s] || configs.disconnected;
    const Icon = config.icon;
    
    return (
      <span className={`flex items-center gap-2 ${config.color}`}>
        <Icon size={16} className={s === 'checking' ? 'animate-spin' : ''} />
        {config.text}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-slate-400 mt-1">Monitor your CJ Price Sync status</p>
        </div>
        <button
          onClick={checkConnections}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Connection Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Shopify Status */}
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Shopify Store</h2>
            <StatusBadge status={status.shopify} />
          </div>
          {status.shopify === 'connected' && status.stats && (
            <div className="flex items-center gap-3 text-slate-300">
              <Package size={20} className="text-emerald-400" />
              <span>{status.stats.totalProducts.toLocaleString()} products</span>
            </div>
          )}
          {status.shopify === 'disconnected' && (
            <Link to="/settings" className="text-emerald-400 hover:text-emerald-300 text-sm flex items-center gap-1">
              Configure in Settings <ArrowRight size={14} />
            </Link>
          )}
        </div>

        {/* CJ/Server Status */}
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">CJ API Server</h2>
            <StatusBadge status={status.cj} />
          </div>
          <p className="text-sm text-slate-400">
            {status.cj === 'connected' 
              ? 'Server is running and ready for price sync'
              : 'Cannot reach the API server'}
          </p>
        </div>
      </div>

      {/* Last Sync Info */}
      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Clock size={20} className="text-blue-400" />
          Last Sync
        </h2>
        
        {status.lastSync ? (
          <div className="space-y-4">
            <p className="text-slate-300">{status.lastSync}</p>
            
            {status.lastSyncResults && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <p className="text-2xl font-bold text-white">{status.lastSyncResults.total || 0}</p>
                  <p className="text-sm text-slate-400">Total Products</p>
                </div>
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <p className="text-2xl font-bold text-emerald-400">{status.lastSyncResults.updated || 0}</p>
                  <p className="text-sm text-slate-400">Updated</p>
                </div>
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <p className="text-2xl font-bold text-blue-400">{status.lastSyncResults.noChange || 0}</p>
                  <p className="text-sm text-slate-400">No Change</p>
                </div>
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <p className="text-2xl font-bold text-red-400">{status.lastSyncResults.errors || 0}</p>
                  <p className="text-sm text-slate-400">Errors</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-slate-400">No sync has been performed yet</p>
        )}
      </div>

      {/* Quick Actions */}
      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <TrendingUp size={20} className="text-emerald-400" />
          Quick Actions
        </h2>
        <div className="flex flex-wrap gap-4">
          <Link
            to="/sync"
            className="flex items-center gap-2 px-6 py-3 bg-emerald-500 hover:bg-emerald-600 rounded-lg transition font-medium"
          >
            <RefreshCw size={18} />
            Start Price Sync
          </Link>
          <Link
            to="/config"
            className="flex items-center gap-2 px-6 py-3 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
          >
            Edit Pricing Rules
          </Link>
          <Link
            to="/history"
            className="flex items-center gap-2 px-6 py-3 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
          >
            View History
          </Link>
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
