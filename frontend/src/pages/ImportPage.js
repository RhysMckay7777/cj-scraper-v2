import React, { useState, useCallback } from 'react';
import {
  Upload,
  FileUp,
  Search,
  Link2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Download,
  Loader2,
  ChevronDown
} from 'lucide-react';
import api from '../utils/api';

const ImportPage = () => {
  // State
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [products, setProducts] = useState([]);
  const [matching, setMatching] = useState(false);
  const [matchResults, setMatchResults] = useState([]);
  const [linking, setLinking] = useState(false);
  const [linkResults, setLinkResults] = useState(null);
  const [selectedMatches, setSelectedMatches] = useState({});
  const [error, setError] = useState('');
  const [step, setStep] = useState('upload'); // upload, products, matching, results

  // Drag and drop handlers
  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  }, []);

  const handleFileInput = (e) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  };

  // Upload and parse file
  const handleFile = async (file) => {
    setError('');
    setUploading(true);
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const response = await api.post('/import-csv', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      
      if (response.data.success) {
        setProducts(response.data.products);
        setStep('products');
      } else {
        setError(response.data.error || 'Failed to parse file');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  // Find CJ matches
  const handleFindMatches = async () => {
    setError('');
    setMatching(true);
    
    try {
      const response = await api.post('/match-products', {
        products: products.map(p => ({ handle: p.handle, title: p.title }))
      });
      
      if (response.data.success) {
        setMatchResults(response.data.results);
        // Pre-select best matches with confidence >= 50
        const preselected = {};
        response.data.results.forEach(r => {
          if (r.bestMatch && r.bestMatch.confidence >= 50) {
            preselected[r.handle] = r.bestMatch.cjProductId;
          }
        });
        setSelectedMatches(preselected);
        setStep('matching');
      } else {
        setError(response.data.error || 'Matching failed');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Matching failed');
    } finally {
      setMatching(false);
    }
  };

  // Link selected products
  const handleLinkProducts = async () => {
    const links = Object.entries(selectedMatches)
      .filter(([_, cjId]) => cjId)
      .map(([handle, cjProductId]) => ({ shopifyHandle: handle, cjProductId }));
    
    if (links.length === 0) {
      setError('No products selected for linking');
      return;
    }

    // Get credentials from localStorage
    const shopifyStore = localStorage.getItem('shopifyStore');
    const shopifyToken = localStorage.getItem('shopifyToken');
    
    if (!shopifyStore || !shopifyToken) {
      setError('Shopify credentials not configured. Go to Settings first.');
      return;
    }

    setError('');
    setLinking(true);

    try {
      const response = await api.post('/link-products', {
        links,
        shopifyStore,
        shopifyToken
      });
      
      if (response.data.success) {
        setLinkResults(response.data);
        setStep('results');
      } else {
        setError(response.data.error || 'Linking failed');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Linking failed');
    } finally {
      setLinking(false);
    }
  };

  // Handle match selection change
  const handleMatchSelect = (handle, cjProductId) => {
    setSelectedMatches(prev => ({
      ...prev,
      [handle]: cjProductId
    }));
  };

  // Download results as CSV
  const downloadResults = () => {
    const rows = [['Shopify Handle', 'Title', 'CJ Product ID', 'Status']];
    
    matchResults.forEach(r => {
      const selected = selectedMatches[r.handle];
      const status = linkResults?.errors?.find(e => e.handle === r.handle)
        ? 'Failed'
        : selected ? 'Linked' : 'Skipped';
      rows.push([r.handle, r.title, selected || '', status]);
    });
    
    const csv = rows.map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'import-results.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Reset to start
  const handleReset = () => {
    setProducts([]);
    setMatchResults([]);
    setSelectedMatches({});
    setLinkResults(null);
    setError('');
    setStep('upload');
  };

  // Confidence color
  const getConfidenceColor = (confidence) => {
    if (confidence >= 70) return 'text-emerald-400';
    if (confidence >= 40) return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <Upload className="text-emerald-400" />
          Import Products
        </h1>
        <p className="text-slate-400 mt-2">
          Upload a Shopify product export CSV to link existing products to CJ Dropshipping
        </p>
      </div>

      {/* Error display */}
      {error && (
        <div className="mb-6 p-4 bg-red-500/20 border border-red-500/30 rounded-lg flex items-center gap-3 text-red-400">
          <AlertCircle size={20} />
          {error}
        </div>
      )}

      {/* Step 1: Upload */}
      {step === 'upload' && (
        <div className="bg-slate-800 rounded-lg p-8">
          <div
            className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
              dragActive
                ? 'border-emerald-500 bg-emerald-500/10'
                : 'border-slate-600 hover:border-slate-500'
            }`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            {uploading ? (
              <div className="flex flex-col items-center gap-4">
                <Loader2 className="animate-spin text-emerald-400" size={48} />
                <p className="text-slate-300">Processing file...</p>
              </div>
            ) : (
              <>
                <FileUp className="mx-auto mb-4 text-slate-400" size={48} />
                <p className="text-lg text-slate-300 mb-2">
                  Drag & drop your CSV file here
                </p>
                <p className="text-slate-500 mb-4">
                  or click to browse
                </p>
                <input
                  type="file"
                  accept=".csv,.gz,.zip"
                  onChange={handleFileInput}
                  className="hidden"
                  id="file-upload"
                />
                <label
                  htmlFor="file-upload"
                  className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer transition"
                >
                  <Upload size={20} />
                  Choose File
                </label>
                <p className="text-xs text-slate-500 mt-4">
                  Accepts .csv, .csv.gz, or .zip (max 50MB)
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Step 2: Products List */}
      {step === 'products' && (
        <div className="bg-slate-800 rounded-lg">
          <div className="p-4 border-b border-slate-700 flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">Uploaded Products</h2>
              <p className="text-sm text-slate-400">{products.length} products found</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleReset}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
              >
                Upload Different File
              </button>
              <button
                onClick={handleFindMatches}
                disabled={matching}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-600 rounded-lg flex items-center gap-2 transition"
              >
                {matching ? (
                  <>
                    <Loader2 className="animate-spin" size={18} />
                    Matching...
                  </>
                ) : (
                  <>
                    <Search size={18} />
                    Find CJ Matches
                  </>
                )}
              </button>
            </div>
          </div>
          
          <div className="max-h-[500px] overflow-y-auto">
            <table className="w-full">
              <thead className="bg-slate-700/50 sticky top-0">
                <tr>
                  <th className="text-left p-3 text-slate-400 font-medium">Title</th>
                  <th className="text-left p-3 text-slate-400 font-medium w-40">SKU</th>
                  <th className="text-left p-3 text-slate-400 font-medium w-24">Variants</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product, i) => (
                  <tr key={i} className="border-t border-slate-700/50 hover:bg-slate-700/30">
                    <td className="p-3 text-white">{product.title}</td>
                    <td className="p-3 text-slate-400 font-mono text-sm">{product.sku || '-'}</td>
                    <td className="p-3 text-slate-400">{product.variantCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Step 3: Matching View */}
      {step === 'matching' && (
        <div className="bg-slate-800 rounded-lg">
          <div className="p-4 border-b border-slate-700 flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">Match Products</h2>
              <p className="text-sm text-slate-400">
                {Object.values(selectedMatches).filter(v => v).length} of {matchResults.length} products selected
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleReset}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
              >
                Start Over
              </button>
              <button
                onClick={handleLinkProducts}
                disabled={linking || Object.values(selectedMatches).filter(v => v).length === 0}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-600 rounded-lg flex items-center gap-2 transition"
              >
                {linking ? (
                  <>
                    <Loader2 className="animate-spin" size={18} />
                    Linking...
                  </>
                ) : (
                  <>
                    <Link2 size={18} />
                    Link Selected
                  </>
                )}
              </button>
            </div>
          </div>
          
          <div className="max-h-[600px] overflow-y-auto">
            {matchResults.map((result, i) => (
              <div key={i} className="p-4 border-t border-slate-700/50">
                <div className="flex items-start gap-4">
                  {/* Shopify Product */}
                  <div className="flex-1">
                    <h3 className="font-medium text-white">{result.title}</h3>
                    <p className="text-xs text-slate-500 font-mono">{result.handle}</p>
                  </div>
                  
                  {/* Match Selector */}
                  <div className="w-96">
                    {result.matches.length > 0 ? (
                      <div className="relative">
                        <select
                          value={selectedMatches[result.handle] || ''}
                          onChange={(e) => handleMatchSelect(result.handle, e.target.value)}
                          className="w-full p-2 bg-slate-700 border border-slate-600 rounded-lg text-white appearance-none pr-10"
                        >
                          <option value="">No match</option>
                          {result.matches.map((match, j) => (
                            <option key={j} value={match.cjProductId}>
                              [{match.confidence}%] {match.cjTitle?.substring(0, 50)}...
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={18} />
                      </div>
                    ) : (
                      <div className="p-2 text-slate-500 text-sm">
                        No matches found
                      </div>
                    )}
                    
                    {/* Best match preview */}
                    {result.bestMatch && selectedMatches[result.handle] === result.bestMatch.cjProductId && (
                      <div className="mt-2 flex items-center gap-3">
                        {result.bestMatch.cjImage && (
                          <img
                            src={result.bestMatch.cjImage}
                            alt=""
                            className="w-12 h-12 object-cover rounded"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-medium ${getConfidenceColor(result.bestMatch.confidence)}`}>
                            {result.bestMatch.confidence}% confidence
                          </p>
                          <p className="text-xs text-slate-400">
                            ${result.bestMatch.cjPrice} USD
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Step 4: Results */}
      {step === 'results' && linkResults && (
        <div className="bg-slate-800 rounded-lg p-6">
          <div className="text-center mb-8">
            <CheckCircle2 className="mx-auto text-emerald-400 mb-4" size={64} />
            <h2 className="text-2xl font-bold text-white mb-2">Import Complete</h2>
            <p className="text-slate-400">
              Successfully linked {linkResults.linked} products to CJ Dropshipping
            </p>
          </div>
          
          <div className="grid grid-cols-2 gap-4 max-w-md mx-auto mb-8">
            <div className="bg-emerald-500/20 border border-emerald-500/30 rounded-lg p-4 text-center">
              <div className="text-3xl font-bold text-emerald-400">{linkResults.linked}</div>
              <div className="text-sm text-slate-400">Linked</div>
            </div>
            <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-4 text-center">
              <div className="text-3xl font-bold text-red-400">{linkResults.failed}</div>
              <div className="text-sm text-slate-400">Failed</div>
            </div>
          </div>
          
          {linkResults.errors.length > 0 && (
            <div className="mb-6 max-h-40 overflow-y-auto bg-slate-900 rounded-lg p-4">
              <h3 className="font-medium text-red-400 mb-2 flex items-center gap-2">
                <XCircle size={18} />
                Errors
              </h3>
              {linkResults.errors.map((err, i) => (
                <div key={i} className="text-sm text-slate-400 py-1">
                  <span className="font-mono">{err.handle}</span>: {err.error}
                </div>
              ))}
            </div>
          )}
          
          <div className="flex justify-center gap-4">
            <button
              onClick={downloadResults}
              className="px-6 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg flex items-center gap-2 transition"
            >
              <Download size={18} />
              Download Results
            </button>
            <button
              onClick={handleReset}
              className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg flex items-center gap-2 transition"
            >
              <Upload size={18} />
              Import More
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ImportPage;
