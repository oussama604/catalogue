// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import slugify from 'slugify';
import pool from './db.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

// middlewares
app.use(cors());               // autoriser appels depuis Duda/admin
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // sert public/admin.html

// helpers
const toSlug = (s) => slugify(s, { lower: true, strict: true, locale: 'fr' });

// ------- routes basiques
app.get('/', (req, res) => res.send('API OK. Essayez /health, /categories, /products, ou /admin.html'));
app.get('/health', (req, res) => res.json({ ok: true }));

// ------- routes publiques (pour Duda)
app.get('/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, slug FROM categories ORDER BY name ASC'
    );
    res.json(rows);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'database_error' });
  }
});

app.get('/products', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.name, p.slug, p.description, p.price, p.stock, p.image_url,
             p.is_available, p.created_at, p.updated_at,
             p.category_id, c.name AS category_name, c.slug AS category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'database_error' });
  }
});

app.get('/products/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.slug = $1
    `, [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'database_error' });
  }
});

// servir une image binaire stockée en base
app.get('/images/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT mime_type, bytes FROM product_images WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).send('Not found');
    res.setHeader('Content-Type', rows[0].mime_type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(rows[0].bytes);
  } catch (e) {
    console.error(e); res.status(500).send('server_error');
  }
});

// ------- routes admin (CRUD) : AUCUNE AUTH ICI (simple). À protéger si besoin.

// CREATE produit (URL image OU upload fichier). Si fichier, stocke en DB et remplace image_url.
app.post('/admin/products', upload.single('image'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name, slug, description, price, stock, category_id, is_available, image_url } = req.body;
    const finalSlug = slug?.trim() || toSlug(name);

    const ins = await client.query(
      `INSERT INTO products (name, slug, description, price, stock, image_url, category_id, is_available)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        name, finalSlug, description || null, price || null, stock || null,
        image_url?.trim() || null, category_id || null, is_available === 'on' || is_available === 'true' || is_available === true
      ]
    );
    const productId = ins.rows[0].id;

    if (req.file) {
      const { buffer, mimetype, size } = req.file;
      const img = await client.query(
        `INSERT INTO product_images (product_id, mime_type, bytes, size_bytes)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [productId, mimetype, buffer, size]
      );
      const imgId = img.rows[0].id;
      await client.query(
        `UPDATE products SET main_image_id=$1, image_url=$2 WHERE id=$3`,
        [imgId, `/images/${imgId}`, productId]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, id: productId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(400).json({ error: e.message || 'create_error' });
  } finally {
    client.release();
  }
});

// UPDATE produit (multipart accepté, remplace l'image si fichier fourni)
app.put('/admin/products/:id', upload.single('image'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const id = req.params.id;
    const { name, slug, description, price, stock, category_id, is_available, image_url } = req.body;
    const finalSlug = slug?.trim() || (name ? toSlug(name) : undefined);

    await client.query(
      `UPDATE products
       SET name = COALESCE($1, name),
           slug = COALESCE($2, slug),
           description = COALESCE($3, description),
           price = COALESCE($4, price),
           stock = COALESCE($5, stock),
           image_url = COALESCE($6, image_url),
           category_id = COALESCE($7, category_id),
           is_available = COALESCE($8, is_available),
           updated_at = now()
       WHERE id = $9`,
      [
        name || null,
        finalSlug || null,
        description || null,
        price || null,
        stock || null,
        (image_url?.trim?.() || null),
        (category_id || null),
        (typeof is_available !== 'undefined'
          ? (is_available === 'on' || is_available === 'true' || is_available === true)
          : null),
        id
      ]
    );

    if (req.file) {
      const { buffer, mimetype, size } = req.file;
      const img = await client.query(
        `INSERT INTO product_images (product_id, mime_type, bytes, size_bytes)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [id, mimetype, buffer, size]
      );
      const imgId = img.rows[0].id;
      await client.query(
        `UPDATE products SET main_image_id=$1, image_url=$2, updated_at=now() WHERE id=$3`,
        [imgId, `/images/${imgId}`, id]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(400).json({ error: e.message || 'update_error' });
  } finally {
    client.release();
  }
});

// DELETE produit
app.delete('/admin/products/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(400).json({ error: e.message || 'delete_error' });
  }
});

// ------- utils dev : ping DB
app.get('/db-ping', async (req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json(r.rows[0]); // { ok: 1 }
  } catch (e) {
    console.error(e); res.status(500).json({ error: e.message });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`✅ API running on http://localhost:${port}`);
});

