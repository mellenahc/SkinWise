import 'dotenv/config';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import express, { type Request, type Response, type RequestHandler } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

const db = new PrismaClient();
const app = express();
const origins = (process.env.CORS_ORIGIN || 'http://localhost:8081,http://localhost:19006')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: origins }));
app.use(express.json({ limit: '32kb' }));

const windows = new Map<string, { count: number; resetAt: number }>();
function rateLimit(max: number, windowMs: number, byRoute = false): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    const key = byRoute ? `${req.ip}:${req.baseUrl || req.path}` : String(req.ip);
    let bucket = windows.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (windows.size >= 10_000) {
        for (const [entry, value] of windows) {
          if (value.resetAt <= now) windows.delete(entry);
        }
        if (windows.size >= 10_000) {
          const oldest = windows.keys().next();
          if (!oldest.done) windows.delete(oldest.value);
        }
      }
      bucket = { count: 0, resetAt: now + windowMs };
      windows.set(key, bucket);
    }
    bucket.count++;
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - bucket.count));
    res.setHeader('RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));
    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

app.use(rateLimit(120, 60_000));
app.use('/auth', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const profileSchema = z.object({
  skinType: z.enum(['dry', 'oily', 'combination', 'normal', 'sensitive']),
  concerns: z.array(z.string().trim().min(1).max(50)).max(12),
});
const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(128),
});
type SkinType = 'dry' | 'oily' | 'combination' | 'normal' | 'sensitive';
const ingredientRules: Record<string, { note: string; cautions: SkinType[]; helps: string[] }> = {
  fragrance: { note: 'Fragrance may irritate reactive skin.', cautions: ['sensitive'], helps: [] },
  parfum: { note: 'Fragrance may irritate reactive skin.', cautions: ['sensitive'], helps: [] },
  'denatured alcohol': { note: 'May contribute to dryness or irritation in some formulations.', cautions: ['dry', 'sensitive'], helps: [] },
  'alcohol denat.': { note: 'May contribute to dryness or irritation in some formulations.', cautions: ['dry', 'sensitive'], helps: [] },
  'salicylic acid': { note: 'Can help with clogged pores, but may cause dryness or irritation.', cautions: ['dry', 'sensitive'], helps: ['acne', 'clogged pores', 'oily skin'] },
  retinol: { note: 'May help acne and uneven texture, but can irritate skin; avoid retinoids during pregnancy unless advised by a clinician.', cautions: ['dry', 'sensitive'], helps: ['acne', 'texture'] },
  glycerin: { note: 'Humectant that helps attract water to the skin.', cautions: [], helps: ['dryness', 'dehydration'] },
  'hyaluronic acid': { note: 'Humectant that supports skin hydration.', cautions: [], helps: ['dryness', 'dehydration'] },
  niacinamide: { note: 'May support the skin barrier and improve the appearance of uneven tone.', cautions: [], helps: ['dark spots', 'uneven tone', 'oiliness'] },
  ceramide: { note: 'Supports the skin barrier.', cautions: [], helps: ['dryness', 'barrier'] },
  'ceramide np': { note: 'Supports the skin barrier.', cautions: [], helps: ['dryness', 'barrier'] },
};

function analyze(ingredients: string[], skinType: SkinType, concerns: string[] = []) {
  const normalized = ingredients.map((ingredient) => ingredient.toLowerCase().trim()).filter(Boolean);
  const findings = ingredients.flatMap((ingredient) => {
    const rule = ingredientRules[ingredient.toLowerCase().trim()];
    if (!rule) return [];
    return [{
      ingredient,
      note: rule.note,
      caution: rule.cautions.includes(skinType),
      benefits: rule.helps.filter((concern) => concerns.some((value) => value.toLowerCase().trim() === concern)),
    }];
  });
  const cautionCount = findings.filter((finding) => finding.caution).length;
  const sufficientlyCovered = normalized.length >= 3 && findings.length >= 2;
  const rating = cautionCount > 0 ? 'use_with_caution' : sufficientlyCovered ? 'good_match' : 'insufficient_information';
  return {
    rating,
    status: cautionCount ? 'review' : 'no_flagged_ingredients',
    findings,
    coverage: { recognized: findings.length, total: normalized.length },
    reasons: rating === 'use_with_caution'
      ? ['One or more ingredients may be irritating for your selected skin type.']
      : rating === 'good_match'
        ? ['No known skin-type cautions found among recognized ingredients; this is not a safety guarantee.']
        : ['Not enough recognized ingredient information to assess compatibility.'],
    disclaimer: 'Educational screening only, not a safety certification or medical advice. Concentration, full formulation, allergies and individual response are not assessed.',
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex || !/^[a-f0-9]{128}$/i.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.get('authorization') || '');
  return match?.[1] ?? null;
}

const requireAuth: RequestHandler = (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  void db.session.findUnique({ where: { tokenHash: hashToken(token) } })
    .then(async (session) => {
      if (!session || session.expiresAt <= new Date()) {
        if (session) await db.session.delete({ where: { id: session.id } });
        return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      }
      res.locals.userId = session.userId;
      res.locals.sessionId = session.id;
      next();
    })
    .catch(next);
};

function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url');
  return db.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  }).then((session) => ({ id: session.id, token }));
}

app.post('/auth/register', rateLimit(8, 15 * 60_000, true), async (req, res, next) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Enter a valid email and a password of 12 to 128 characters.' });
  }
  try {
    const user = await db.user.create({
      data: { email: parsed.data.email, passwordHash: hashPassword(parsed.data.password) },
      select: { id: true, email: true },
    });
    const session = await createSession(user.id);
    return res.status(201).json({ user, ...session });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    return next(error);
  }
});

app.post('/auth/login', rateLimit(8, 15 * 60_000, true), async (req, res, next) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and password.' });
  try {
    const user = await db.user.findUnique({ where: { email: parsed.data.email } });
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const session = await createSession(user.id);
    return res.json({ user: { id: user.id, email: user.email }, ...session });
  } catch (error) {
    return next(error);
  }
});

app.get('/auth/me', requireAuth, async (_req, res, next) => {
  try {
    const user = await db.user.findUnique({
      where: { id: res.locals.userId },
      select: { id: true, email: true },
    });
    return user ? res.json({ user }) : res.sendStatus(401);
  } catch (error) {
    return next(error);
  }
});

app.delete('/auth/session', requireAuth, async (_req, res, next) => {
  try {
    await db.session.delete({ where: { id: res.locals.sessionId } });
    return res.sendStatus(204);
  } catch (error) {
    return next(error);
  }
});

app.delete('/auth/account', requireAuth, async (_req, res, next) => {
  try {
    await db.user.delete({ where: { id: res.locals.userId } });
    return res.sendStatus(204);
  } catch (error) {
    return next(error);
  }
});

app.use('/profiles', requireAuth);
app.use('/profiles', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.post('/profiles', async (req, res, next) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());
  try {
    const profile = await db.profile.create({
      data: { ...parsed.data, userId: res.locals.userId },
    });
    return res.status(201).json(profile);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: 'This account already has a profile. Update it instead.' });
    }
    return next(error);
  }
});

app.get('/profiles/me', async (_req, res, next) => {
  try {
    const profile = await db.profile.findUnique({ where: { userId: res.locals.userId } });
    return profile ? res.json(profile) : res.sendStatus(404);
  } catch (error) {
    return next(error);
  }
});

app.get('/profiles/:id', async (req, res, next) => {
  try {
    const profile = await db.profile.findFirst({
      where: { id: req.params.id, userId: res.locals.userId },
    });
    return profile ? res.json(profile) : res.sendStatus(404);
  } catch (error) {
    return next(error);
  }
});

app.put('/profiles/:id', async (req, res, next) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());
  try {
    const result = await db.profile.updateMany({
      where: { id: req.params.id, userId: res.locals.userId },
      data: parsed.data,
    });
    if (result.count === 0) return res.sendStatus(404);
    return res.json(await db.profile.findUnique({ where: { id: req.params.id } }));
  } catch (error) {
    return next(error);
  }
});

const BEAUTY_BASE = 'https://api.thebeautyapi.com/v1';
const OPEN_BEAUTY_BASE = 'https://world.openbeautyfacts.org/api/v2/product';
class ProviderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const responseCache = new Map<string, { value: unknown; expiresAt: number }>();
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = responseCache.get(key);
  if (existing && existing.expiresAt > now) {
    responseCache.delete(key);
    responseCache.set(key, existing);
    return existing.value as T;
  }
  if (existing) responseCache.delete(key);
  const value = await load();
  while (responseCache.size >= 500) {
    const oldest = responseCache.keys().next();
    if (oldest.done) break;
    responseCache.delete(oldest.value);
  }
  responseCache.set(key, { value, expiresAt: now + 5 * 60_000 });
  return value;
}

async function providerJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let response: globalThis.Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new ProviderError(502, 'Product provider is unreachable');
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderError(502, 'Product provider returned invalid JSON');
  }
}

async function beauty(path: string): Promise<any> {
  if (!process.env.BEAUTY_API_KEY) throw new ProviderError(503, 'BEAUTY_API_KEY is not configured');
  return cached(`beauty:${path}`, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: globalThis.Response;
      try {
        response = await fetch(`${BEAUTY_BASE}${path}`, {
          headers: { 'x-api-key': process.env.BEAUTY_API_KEY!, accept: 'application/json' },
          signal: AbortSignal.timeout(12_000),
        });
      } catch {
        throw new ProviderError(502, 'Product provider is unreachable');
      }
      if (response.status === 429 && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      let payload: any;
      try {
        payload = await response.json();
      } catch {
        throw new ProviderError(502, 'Product provider returned invalid JSON');
      }
      if (!response.ok) {
        throw new ProviderError(
          response.status === 403 ? 502 : response.status,
          response.status === 403 ? 'Product provider authentication failed' : String(payload.message || 'Product provider request failed'),
        );
      }
      return payload;
    }
    throw new ProviderError(429, 'Product provider rate limit reached');
  });
}

function productSummary(raw: any): {
  id: string;
  name: string;
  brand: string;
  category: string;
  image_url: string | null;
  ingredients: string[];
  barcode?: string | null;
  source?: string;
} {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name || ''),
    brand: String(raw.brand || ''),
    category: String(raw.category || ''),
    image_url: raw.image_url || null,
    ingredients: [],
  };
}

function extractIngredients(raw: any): string[] {
  const list = raw.ingredients ?? raw.ingredient_list ?? raw.inci_ingredients ?? [];
  if (Array.isArray(list)) {
    return list.map((value: any) => typeof value === 'string'
      ? value
      : String(value?.name || value?.inci_name || value?.ingredient?.name || ''))
      .filter(Boolean);
  }
  if (typeof list === 'string') return list.split(',').map((value: string) => value.trim()).filter(Boolean);
  return [];
}

function openBeautySummary(code: string, raw: any) {
  const product = raw.product || {};
  if (raw.status !== 1 || !product.product_name && !product.product_name_en) {
    throw new ProviderError(404, 'No product was found for this barcode.');
  }
  const ingredients = Array.isArray(product.ingredients)
    ? product.ingredients.map((ingredient: any) => String(ingredient.text || ingredient.id || '')).filter(Boolean)
    : typeof product.ingredients_text === 'string'
      ? product.ingredients_text.split(',').map((ingredient: string) => ingredient.trim()).filter(Boolean)
      : [];
  return {
    id: `obf-${code}`,
    barcode: code,
    name: String(product.product_name || product.product_name_en),
    brand: String(product.brands || ''),
    category: String(product.categories || ''),
    image_url: product.image_front_url || product.image_url || null,
    ingredients,
    source: 'Open Beauty Facts',
  };
}

async function openBeautyProduct(code: string) {
  return cached(`obf:${code}`, async () => {
    const url = `${OPEN_BEAUTY_BASE}/${encodeURIComponent(code)}.json?fields=status,product_name,product_name_en,brands,categories,image_front_url,image_url,ingredients_text,ingredients`;
    const payload = await providerJson(url, {
      accept: 'application/json',
      'user-agent': 'SkinWise-MVP/1.0 (barcode product lookup)',
    });
    return openBeautySummary(code, payload);
  });
}

async function saveProduct(product: ReturnType<typeof productSummary>) {
  const existing = product.barcode
    ? await db.product.findUnique({ where: { barcode: product.barcode } })
    : null;
  const id = existing?.id || product.id;
  await db.product.upsert({
    where: { id },
    create: {
      id,
      name: product.name,
      brand: product.brand,
      category: product.category,
      barcode: product.barcode ?? null,
      ingredients: product.ingredients,
      source: product.source ?? null,
    },
    update: {
      name: product.name,
      brand: product.brand,
      category: product.category,
      barcode: product.barcode ?? null,
      ingredients: product.ingredients,
      source: product.source ?? null,
    },
  });
  return { ...product, id };
}

async function fullProduct(id: string) {
  const local = await db.product.findUnique({ where: { id } });
  if (local?.source === 'Open Beauty Facts' && local.barcode) {
    const product = await openBeautyProduct(local.barcode);
    await saveProduct(product);
    return product;
  }
  if (id.startsWith('obf-')) {
    const product = await openBeautyProduct(id.slice(4));
    return saveProduct(product);
  }
  const raw = await beauty(`/products/${encodeURIComponent(id)}`);
  const data = raw.product ?? raw.data ?? raw;
  const product = { ...productSummary(data), ingredients: extractIngredients(data) };
  if (!product.id || !product.name) throw new ProviderError(502, 'Provider returned an incomplete product');
  return saveProduct(product);
}

app.get('/products', async (req, res, next) => {
  try {
    const parsed = z.object({
      q: z.string().trim().min(1).max(100),
      page: z.coerce.number().int().min(1).max(51).default(1),
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Provide q (1-100 characters) and page (1-51)' });
    const result = await beauty(`/products/search?${new URLSearchParams({
      q: parsed.data.q,
      page: String(parsed.data.page),
    })}`);
    const items = Array.isArray(result) ? result : result.products ?? result.results ?? result.data ?? [];
    return res.json({
      products: Array.isArray(items) ? items.map(productSummary) : [],
      pagination: result.pagination ?? null,
      no_match: result.no_match ?? null,
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/products/barcode/:code', async (req, res, next) => {
  const code = req.params.code;
  if (!/^(?:[0-9]{8}|[0-9]{12,14})$/.test(code)) {
    return res.status(400).json({ error: 'Barcode must be a valid EAN or UPC number.' });
  }
  try {
    const product = await openBeautyProduct(code);
    const saved = await saveProduct(product);
    return res.json(saved);
  } catch (error) {
    return next(error);
  }
});

app.get('/products/:id', async (req, res, next) => {
  try {
    return res.json(await fullProduct(req.params.id));
  } catch (error) {
    return next(error);
  }
});

app.get('/products/:id/analysis', async (req, res, next) => {
  try {
    const parsed = z.object({
      skinType: z.enum(['dry', 'oily', 'combination', 'normal', 'sensitive']).default('combination'),
      concerns: z.string().max(500).optional(),
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid skin profile' });
    const product = await fullProduct(req.params.id);
    const concerns = parsed.data.concerns?.split(',').map((value) => value.trim()).filter(Boolean).slice(0, 12) || [];
    return res.json({ product, analysis: analyze(product.ingredients, parsed.data.skinType, concerns) });
  } catch (error) {
    return next(error);
  }
});

app.get('/ingredients/search', async (req, res, next) => {
  try {
    const parsed = z.object({
      q: z.string().trim().min(1).max(100),
      page: z.coerce.number().int().min(1).max(51).default(1),
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid ingredient search' });
    return res.json(await beauty(`/ingredients/search?${new URLSearchParams({
      q: parsed.data.q,
      page: String(parsed.data.page),
    })}`));
  } catch (error) {
    return next(error);
  }
});

app.get('/profiles/:id/routines', async (req, res, next) => {
  try {
    const profile = await db.profile.findFirst({
      where: { id: req.params.id, userId: res.locals.userId },
      select: { id: true },
    });
    if (!profile) return res.sendStatus(404);
    const routines = await db.routine.findMany({
      where: { profileId: profile.id },
      include: { product: true },
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(routines);
  } catch (error) {
    return next(error);
  }
});

app.post('/profiles/:id/routines', async (req, res, next) => {
  const parsed = z.object({
    productId: z.string().min(1).max(200),
    period: z.enum(['AM', 'PM']),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());
  try {
    const profile = await db.profile.findFirst({
      where: { id: req.params.id, userId: res.locals.userId },
      select: { id: true },
    });
    if (!profile) return res.sendStatus(404);
    const routine = await db.routine.create({
      data: { profileId: profile.id, ...parsed.data },
    });
    return res.status(201).json(routine);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError
      && (error.code === 'P2002' || error.code === 'P2003')) {
      return res.status(409).json({ error: 'Product is invalid or already in this routine.' });
    }
    return next(error);
  }
});

app.delete('/routines/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await db.routine.deleteMany({
      where: { id: req.params.id, profile: { userId: res.locals.userId } },
    });
    return result.count ? res.sendStatus(204) : res.sendStatus(404);
  } catch (error) {
    return next(error);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error(error);
  if (error instanceof ProviderError) return res.status(error.status).json({ error: error.message });
  return res.status(500).json({ error: 'Server error' });
});

const server = app.listen(Number(process.env.PORT || 4000), () => console.log('SkinWise API running'));
async function shutdown() {
  server.close();
  await db.$disconnect();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
