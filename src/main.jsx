import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Deliberately not wrapped in StrictMode: the bulk runner owns long-lived
// async workers and we do not want double-invoked effects kicking off two
// generations of the same queue during development.
createRoot(document.getElementById('root')).render(<App />);
