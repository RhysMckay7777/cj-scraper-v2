// API utilities

export function getApiUrl() {
  // In production (same host), use relative paths
  // In development, use environment variable or localhost
  if (process.env.NODE_ENV === 'production') {
    return '';
  }
  return process.env.REACT_APP_API_URL || 'http://localhost:8080';
}

export function getCredentials() {
  return {
    shopifyStore: localStorage.getItem('shopifyStore') || '',
    shopifyToken: localStorage.getItem('shopifyToken') || ''
  };
}

export function saveCredentials(store, token) {
  localStorage.setItem('shopifyStore', store);
  localStorage.setItem('shopifyToken', token);
}

export function clearCredentials() {
  localStorage.removeItem('shopifyStore');
  localStorage.removeItem('shopifyToken');
}

export async function apiRequest(endpoint, options = {}) {
  const url = `${getApiUrl()}${endpoint}`;
  const creds = getCredentials();
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    body: options.body ? JSON.stringify({
      ...JSON.parse(options.body || '{}'),
      shopifyStore: creds.shopifyStore,
      shopifyToken: creds.shopifyToken
    }) : undefined
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  
  return response.json();
}
