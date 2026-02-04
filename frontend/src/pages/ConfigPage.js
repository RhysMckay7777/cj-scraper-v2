import React, { useState, useEffect } from 'react';
import { 
  Save, 
  RefreshCw, 
  Sliders,
  DollarSign,
  Percent,
  RotateCcw,
  CheckCircle,
  AlertCircle
} from 'lucide-react';
import { getApiUrl } from '../utils/api';

const DEFAULT_CONFIG = {
  markup_multiplier: 2.0,
  min_price: 19.99,
  max_price: null,
  round_to: 0.95,
  show_compare_at: false,
  compare_at_markup: 1.3
};

function ConfigPage() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${getApiUrl()}/api/sync-prices/config`);
      const data = await response.json();
      if (data.success && data.config) {
        setConfig({ ...DEFAULT_CONFIG, ...data.config });
      }
    } catch (e) {
      console.error('Failed to fetch config:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch(`${getApiUrl()}/api/sync-prices/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config })
      });

      const data = await response.json();

      if (data.success) {
        setMessage({ type: 'success', text: 'Configuration saved successfully!' });
      } else {
        throw new Error(data.error || 'Failed to save');
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(null), 3000);
    }
  };

  const handleReset = () => {
    if (window.confirm('Reset all settings to defaults?')) {
      setConfig(DEFAULT_CONFIG);
      setMessage({ type: 'success', text: 'Reset to defaults. Click Save to apply.' });
    }
  };

  const updateConfig = (key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  // Calculate example price
  const exampleCost = 12.50;
  const examplePrice = Math.max(
    config.min_price || 0,
    Math.min(
      config.max_price || Infinity,
      Math.floor((exampleCost * config.markup_multiplier) / (config.round_to || 1)) * (config.round_to || 1) + (config.round_to || 0)
    )
  );
  const exampleCompareAt = config.show_compare_at 
    ? (examplePrice * config.compare_at_markup).toFixed(2)
    : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-slate-400" size={32} />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Pricing Configuration</h1>
        <p className="text-slate-400 mt-1">Configure how prices are calculated during sync</p>
      </div>

      {/* Message */}
      {message && (
        <div className={`p-4 rounded-lg flex items-center gap-3 ${
          message.type === 'success' 
            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
            : 'bg-red-500/20 text-red-400 border border-red-500/30'
        }`}>
          {message.type === 'success' ? <CheckCircle size={20} /> : <AlertCircle size={20} />}
          {message.text}
        </div>
      )}

      {/* Example Preview */}
      <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-6">
        <h3 className="font-semibold text-blue-400 mb-3 flex items-center gap-2">
          <DollarSign size={18} />
          Price Preview
        </h3>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="bg-slate-800 rounded-lg px-4 py-2">
            <span className="text-slate-400 text-sm">CJ Cost</span>
            <p className="text-lg font-mono">${exampleCost.toFixed(2)}</p>
          </div>
          <span className="text-slate-500">→</span>
          <div className="bg-emerald-500/20 rounded-lg px-4 py-2 border border-emerald-500/30">
            <span className="text-emerald-400 text-sm">Selling Price</span>
            <p className="text-lg font-mono text-emerald-400">${examplePrice.toFixed(2)}</p>
          </div>
          {exampleCompareAt && (
            <>
              <div className="bg-slate-800 rounded-lg px-4 py-2">
                <span className="text-slate-400 text-sm">Compare At</span>
                <p className="text-lg font-mono line-through text-slate-400">${exampleCompareAt}</p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Config Form */}
      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Sliders size={20} className="text-emerald-400" />
          <h2 className="text-lg font-semibold">Pricing Rules</h2>
        </div>

        {/* Markup Multiplier */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            <Percent size={14} className="inline mr-1" />
            Markup Multiplier
          </label>
          <input
            type="number"
            step="0.1"
            min="1"
            value={config.markup_multiplier}
            onChange={(e) => updateConfig('markup_multiplier', parseFloat(e.target.value) || 1)}
            className="w-full px-4 py-3 bg-slate-900 border border-slate-600 rounded-lg focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none transition"
          />
          <p className="text-xs text-slate-500 mt-1">
            Multiply CJ cost by this amount (2.0 = 100% markup)
          </p>
        </div>

        {/* Min/Max Price */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Minimum Price ($)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={config.min_price || ''}
              onChange={(e) => updateConfig('min_price', e.target.value ? parseFloat(e.target.value) : null)}
              placeholder="No minimum"
              className="w-full px-4 py-3 bg-slate-900 border border-slate-600 rounded-lg focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none transition"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Maximum Price ($)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={config.max_price || ''}
              onChange={(e) => updateConfig('max_price', e.target.value ? parseFloat(e.target.value) : null)}
              placeholder="No maximum"
              className="w-full px-4 py-3 bg-slate-900 border border-slate-600 rounded-lg focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none transition"
            />
          </div>
        </div>

        {/* Round To */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Round Prices To
          </label>
          <div className="flex gap-3">
            {[0.95, 0.99, 0.00].map((value) => (
              <button
                key={value}
                onClick={() => updateConfig('round_to', value)}
                className={`px-4 py-2 rounded-lg border transition ${
                  config.round_to === value
                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                    : 'bg-slate-900 border-slate-600 hover:border-slate-500'
                }`}
              >
                {value === 0 ? 'No rounding' : `$X.${value.toString().split('.')[1]}`}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Prices will be rounded to end in this value (e.g., $24.95)
          </p>
        </div>

        {/* Compare At Price */}
        <div className="border-t border-slate-700 pt-6">
          <label className="flex items-center gap-3 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={config.show_compare_at}
              onChange={(e) => updateConfig('show_compare_at', e.target.checked)}
              className="w-5 h-5 rounded border-slate-500 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-800"
            />
            <span className="font-medium">Show Compare-At Price</span>
          </label>

          {config.show_compare_at && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Compare-At Markup
              </label>
              <input
                type="number"
                step="0.1"
                min="1"
                value={config.compare_at_markup}
                onChange={(e) => updateConfig('compare_at_markup', parseFloat(e.target.value) || 1)}
                className="w-full px-4 py-3 bg-slate-900 border border-slate-600 rounded-lg focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none transition"
              />
              <p className="text-xs text-slate-500 mt-1">
                Compare-at price = Selling price × this value (1.3 = 30% higher)
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-4 border-t border-slate-700">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-6 py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 rounded-lg transition font-medium"
          >
            <Save size={18} />
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-4 py-3 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
          >
            <RotateCcw size={18} />
            Reset to Defaults
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700">
        <h3 className="font-semibold mb-3">How Pricing Works</h3>
        <ol className="text-sm text-slate-400 space-y-2 list-decimal list-inside">
          <li>Get the current CJ product cost</li>
          <li>Multiply by the markup multiplier (e.g., $12.50 × 2.0 = $25.00)</li>
          <li>Round to the specified ending (e.g., $25.00 → $24.95)</li>
          <li>Enforce minimum/maximum price limits</li>
          <li>Optionally calculate compare-at price for strikethrough</li>
        </ol>
      </div>
    </div>
  );
}

export default ConfigPage;
