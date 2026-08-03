const { Hono } = require('hono');
const { getClientSettings } = require('../lib/planLimits');

const branding = new Hono();

branding.get('/', async (c) => {
  const settings = await getClientSettings(c.env.DB);
  return c.json({
    business_name: settings.business_name || null,
    has_logo: !!settings.logo_data_url,
    logo_url: settings.logo_data_url ? `/api/branding/logo?v=${encodeURIComponent(settings.updated_at || '')}` : null,
  });
});

branding.get('/logo', async (c) => {
  const settings = await getClientSettings(c.env.DB);
  if (!settings.logo_data_url) return c.json({ error: 'No logo configured for this deployment.' }, 404);

  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(settings.logo_data_url);
  if (!match) return c.json({ error: 'Stored logo data is malformed.' }, 500);

  const [, mimeType, base64] = match;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

module.exports = branding;
// NAFDAC approved-product catalog — read-only reference data (migration 0002).
//
// PURPOSE: let a pharmacy build its inventory by SELECTING from the 6,801
// currently-registered NAFDAC products instead of typing every field by hand,
// and surface therapeutic alternatives that share an active ingredient.
//
// AUTHORISATION: authRequired only, deliberately NOT managerOnly. Ordinary
// STAFF need to search this from the POS ("we're out of Panadol — what else
// has paracetamol in it?"). It is public regulatory data containing no client
// information, so there is nothing here to scope per branch or per tenant.
// Actually CREATING a product from a catalog row is still managerOnly — that
// gate lives on POST /api/products, unchanged.
