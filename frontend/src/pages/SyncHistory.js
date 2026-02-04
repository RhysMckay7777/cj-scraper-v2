import React, { useState, useEffect } from 'react';
import { 
  History, 
  ChevronDown, 
  ChevronUp,
  Trash2,
  Clock,
  CheckCircle,
  XCircle,
  Package
} from 'lucide-react';

function SyncHistory() {
  const [history, setHistory] = useState([]);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = () => {
    const stored = localStorage.getItem('syncHistory');
    if (stored) {
      setHistory(JSON.parse(stored));
    }
  };

  const clearHistory = () => {
    if (window.confirm('Clear all sync history?')) {
      localStorage.removeItem('syncHistory');
      localStorage.removeItem('lastSyncTime');
      localStorage.removeItem('lastSyncResults');
      setHistory([]);
    }
  };

  const formatDate = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const toggleExpand = (idx) => {
    setExpandedId(expandedId === idx ? null : idx);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sync History</h1>
          <p className="text-slate-400 mt-1">View past price sync operations</p>
        </div>
        {history.length > 0 && (
          <button
            onClick={clearHistory}
            className="flex items-center gap-2 px-4 py-2 text-red-400 hover:bg-red-500/20 rounded-lg transition"
          >
            <Trash2 size={18} />
            Clear History
          </button>
        )}
      </div>

      {/* History List */}
      {history.length > 0 ? (
        <div className="space-y-3">
          {history.map((item, idx) => (
            <div 
              key={idx}
              className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden"
            >
              {/* Summary Row */}
              <button
                onClick={() => toggleExpand(idx)}
                className="w-full px-6 py-4 flex items-center justify-between hover:bg-slate-700/30 transition"
              >
                <div className="flex items-center gap-4">
                  <div className="p-2 bg-emerald-500/20 rounded-lg">
                    <History size={20} className="text-emerald-400" />
                  </div>
                  <div className="text-left">
                    <p className="font-medium">{formatDate(item.timestamp)}</p>
                    <div className="flex items-center gap-4 text-sm text-slate-400 mt-1">
                      <span className="flex items-center gap-1">
                        <Package size={14} />
                        {item.summary?.total || 0} products
                      </span>
                      <span className="flex items-center gap-1 text-emerald-400">
                        <CheckCircle size={14} />
                        {item.summary?.updated || 0} updated
                      </span>
                      {(item.summary?.errors || 0) > 0 && (
                        <span className="flex items-center gap-1 text-red-400">
                          <XCircle size={14} />
                          {item.summary.errors} errors
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {expandedId === idx ? (
                  <ChevronUp size={20} className="text-slate-400" />
                ) : (
                  <ChevronDown size={20} className="text-slate-400" />
                )}
              </button>

              {/* Expanded Details */}
              {expandedId === idx && item.products && (
                <div className="border-t border-slate-700 px-6 py-4 bg-slate-900/50">
                  <h4 className="text-sm font-medium text-slate-400 mb-3">Updated Products</h4>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {item.products.slice(0, 20).map((product, pidx) => (
                      <div 
                        key={pidx}
                        className="flex items-center justify-between py-2 px-3 bg-slate-800 rounded-lg"
                      >
                        <span className="text-sm truncate max-w-xs">
                          {product.title || product.productId}
                        </span>
                        <div className="flex items-center gap-3 text-sm">
                          {product.oldPrice && product.newPrice && (
                            <>
                              <span className="text-slate-500 line-through">
                                ${parseFloat(product.oldPrice).toFixed(2)}
                              </span>
                              <span className="text-emerald-400">
                                ${parseFloat(product.newPrice).toFixed(2)}
                              </span>
                            </>
                          )}
                          {product.success ? (
                            <CheckCircle size={16} className="text-emerald-400" />
                          ) : (
                            <XCircle size={16} className="text-red-400" />
                          )}
                        </div>
                      </div>
                    ))}
                    {item.products.length > 20 && (
                      <p className="text-sm text-slate-500 text-center py-2">
                        +{item.products.length - 20} more products
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl p-12 border border-slate-700 text-center">
          <Clock className="mx-auto text-slate-600 mb-4" size={48} />
          <h2 className="text-xl font-semibold mb-2">No Sync History</h2>
          <p className="text-slate-400">
            Your price sync history will appear here after you perform your first sync.
          </p>
        </div>
      )}

      {/* Info */}
      {history.length > 0 && (
        <div className="text-sm text-slate-500 text-center">
          Showing last {history.length} sync{history.length > 1 ? 's' : ''} (max 20 stored locally)
        </div>
      )}
    </div>
  );
}

export default SyncHistory;
