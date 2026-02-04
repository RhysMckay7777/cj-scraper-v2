import React, { useState, useEffect } from 'react';
import { 
  Save, 
  Eye, 
  EyeOff, 
  CheckCircle, 
  AlertCircle,
  Trash2,
  Store,
  Key,
  Server
} from 'lucide-react';
import { getCredentials, saveCredentials, clearCredentials, getApiUrl } from '../utils/api';

function SettingsPage() {
  const [shopifyStore, setShopifyStore] = useState('');
  const [shopifyToken, setShopifyToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState({ shopify: null, server: null });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    // Load saved credentials
    const creds = getCredentials();
    setShopifyStore(creds.shopifyStore);
    setShopifyToken(creds.shopifyToken);
    
    // Check server status
    checkServerStatus();
  }, []);

  const checkServerStatus = async () => {
    try {
      const response = await fetch(`${getApiUrl()}/health`);
      if (response.ok) {
        setStatus(s => ({ ...s, server: 'connected' }));
      } else {
        setStatus(s => ({ ...s, server: 'error' }));
      }
    } catch {
      setStatus(s => ({ ...s, server: 'error' }));
    }
  };

  const testConnection = async () => {
    if (!shopifyStore || !shopifyToken) {
      setMessage({ type: 'error', text: 'Please enter both store URL and API token' });
      return;
    }

    setStatus(s => ({ ...s, shopify: 'checking' }));
    
    // Clean up store URL
    let cleanStore = shopifyStore.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    
    try {
      // Use backend proxy to avoid CORS
      const response = await fetch(`${getApiUrl()}/api/test-connection`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          shopifyStore: cleanStore,
          shopifyToken: shopifyToken
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        setStatus(s => ({ ...s, shopify: 'connected' }));
        setMessage({ 
          type: 'success', 
          text: `Connected to ${data.shop.name} (${data.shop.myshopify_domain})`
        });
        // Update with clean URL
        setShopifyStore(cleanStore);
      } else {
        setStatus(s => ({ ...s, shopify: 'error' }));
        setMessage({ type: 'error', text: data.error || 'Invalid credentials or store not found' });
      }
    } catch (e) {
      setStatus(s => ({ ...s, shopify: 'error' }));
      setMessage({ type: 'error', text: `Connection failed: ${e.message}` });
    }
  };

  const handleSave = () => {
    setSaving(true);
    
    // Clean store URL
    const cleanStore = shopifyStore.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    
    saveCredentials(cleanStore, shopifyToken);
    setShopifyStore(cleanStore);
    
    setMessage({ type: 'success', text: 'Settings saved successfully!' });
    setSaving(false);
    
    setTimeout(() => setMessage(null), 3000);
  };

  const handleClear = () => {
    if (window.confirm('Are you sure you want to clear all saved credentials?')) {
      clearCredentials();
      setShopifyStore('');
      setShopifyToken('');
      setStatus({ shopify: null, server: status.server });
      setMessage({ type: 'success', text: 'Credentials cleared' });
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-slate-400 mt-1">Configure your Shopify store connection</p>
      </div>

      {/* Message */}
      {message && (
        <div className={`p-4 rounded-lg flex items-center gap-3 ${
          message.type === 'success' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
          'bg-red-500/20 text-red-400 border border-red-500/30'
        }`}>
          {message.type === 'success' ? <CheckCircle size={20} /> : <AlertCircle size={20} />}
          {message.text}
        </div>
      )}

      {/* Server Status */}
      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
        <div className="flex items-center gap-3 mb-2">
          <Server size={20} className="text-blue-400" />
          <h2 className="text-lg font-semibold">API Server Status</h2>
        </div>
        <div className="flex items-center gap-2">
          {status.server === 'connected' ? (
            <>
              <CheckCircle size={16} className="text-emerald-400" />
              <span className="text-emerald-400">Connected</span>
              <span className="text-slate-500 text-sm ml-2">{getApiUrl() || window.location.origin}</span>
            </>
          ) : status.server === 'error' ? (
            <>
              <AlertCircle size={16} className="text-red-400" />
              <span className="text-red-400">Cannot reach server</span>
            </>
          ) : (
            <span className="text-slate-400">Checking...</span>
          )}
        </div>
      </div>

      {/* Shopify Credentials */}
      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Store size={20} className="text-emerald-400" />
          <h2 className="text-lg font-semibold">Shopify Store</h2>
          {status.shopify === 'connected' && (
            <span className="px-2 py-1 bg-emerald-500/20 text-emerald-400 text-xs rounded-full">
              Connected
            </span>
          )}
        </div>

        {/* Store URL */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Store URL
          </label>
          <input
            type="text"
            value={shopifyStore}
            onChange={(e) => setShopifyStore(e.target.value)}
            placeholder="your-store.myshopify.com"
            className="w-full px-4 py-3 bg-slate-900 border border-slate-600 rounded-lg focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none transition"
          />
          <p className="text-xs text-slate-500 mt-1">
            Enter your store's myshopify.com URL (without https://)
          </p>
        </div>

        {/* API Token */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            <Key size={14} className="inline mr-1" />
            Admin API Access Token
          </label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={shopifyToken}
              onChange={(e) => setShopifyToken(e.target.value)}
              placeholder="shpat_xxxxxxxxxxxxxxxxxx"
              className="w-full px-4 py-3 pr-12 bg-slate-900 border border-slate-600 rounded-lg focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none transition"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition"
            >
              {showToken ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Create an Admin API app in your Shopify admin with read/write products access
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-3 pt-4 border-t border-slate-700">
          <button
            onClick={testConnection}
            disabled={!shopifyStore || !shopifyToken}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition"
          >
            Test Connection
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 rounded-lg transition"
          >
            <Save size={18} />
            Save Settings
          </button>
          <button
            onClick={handleClear}
            className="flex items-center gap-2 px-4 py-2 text-red-400 hover:bg-red-500/20 rounded-lg transition ml-auto"
          >
            <Trash2 size={18} />
            Clear
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-6">
        <h3 className="font-semibold text-blue-400 mb-2">How to get your API Token</h3>
        <ol className="text-sm text-slate-300 space-y-2 list-decimal list-inside">
          <li>Go to your Shopify Admin → Settings → Apps and sales channels</li>
          <li>Click "Develop apps" → "Create an app"</li>
          <li>Name your app (e.g., "CJ Price Sync")</li>
          <li>Go to "Configuration" → "Admin API integration"</li>
          <li>Enable these scopes: <code className="bg-slate-800 px-1 rounded">read_products, write_products</code></li>
          <li>Install the app and copy the Admin API access token</li>
        </ol>
      </div>
    </div>
  );
}

export default SettingsPage;
