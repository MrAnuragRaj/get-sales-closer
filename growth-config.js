/**
 * Growth Engine — environment configuration.
 *
 * Set window.GROWTH_API_BASE to the deployed Growth Engine URL for each environment.
 * This file is the ONLY place the API base URL is configured.
 *
 * Environments:
 *   Development : http://localhost:8000
 *   Production  : https://<your-growth-engine>.railway.app   ← update before launch
 *
 * DO NOT hardcode a URL anywhere else. All pages load this file and read
 * window.GROWTH_API_BASE. Changing it here changes it everywhere.
 */
window.GROWTH_API_BASE = 'https://get-sales-closer-production.up.railway.app';
