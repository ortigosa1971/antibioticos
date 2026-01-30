import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import pg from "pg";
// Envío de correos eliminado (nodemailer) para simplificar despliegue.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --------- DB (Postgres) ---------
const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false } })
  : null;

async function dbQuery(text, params) {
  if (!pool) throw new Error("Falta DATABASE_URL en Railway (Postgres)");
  return pool.query(text, params);
}

async function initDb() {
  if (!pool) return;
  const sqlPath = path.join(__dirname, "db.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await dbQuery(sql);

  // Tabla de salidas (log)
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS salidas (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      antibiograma_id INT NOT NULL REFERENCES antibiogramas(id) ON DELETE CASCADE,
      unidades INT NOT NULL
    );
  `);
}

// --------- API ---------
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/dbcheck", async (req, res) => {
  try {
    const r = await dbQuery("SELECT 1 as ok");
    res.json({ ok: true, db: r.rows?.[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/antibiogramas", async (req, res) => {
  try {
    const r = await dbQuery("SELECT id, nombre FROM antibiogramas ORDER BY nombre");
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/antibioticos", async (req, res) => {
  try {
    const r = await dbQuery(
      "SELECT codigo, nombre, cantidad, stock_minimo FROM antibioticos ORDER BY nombre"
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Alertas: stock bajo (cantidad <= stock_minimo)
app.get("/api/alerts/low-stock", async (req, res) => {
  try {
    const r = await dbQuery(
      `
      SELECT codigo, nombre, cantidad, stock_minimo
      FROM antibioticos
      WHERE cantidad <= stock_minimo
      ORDER BY (cantidad - stock_minimo) ASC, nombre ASC
      `
    );
    res.json({ ok: true, count: r.rows.length, items: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "low-stock query failed", details: String(e?.message || e) });
  }
});

app.get("/api/antibiogramas/:id/antibioticos", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const r = await dbQuery(
      "SELECT antibiotico_codigo AS codigo FROM antibiograma_antibiotico WHERE antibiograma_id=$1 ORDER BY antibiotico_codigo",
      [id]
    );
    res.json(r.rows.map((x) => x.codigo));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/antibiogramas/:id/antibioticos_detalle", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const r = await dbQuery(
      `
      SELECT a.codigo, a.nombre, a.cantidad, a.stock_minimo
      FROM antibiograma_antibiotico aa
      JOIN antibioticos a ON a.codigo = aa.antibiotico_codigo
      WHERE aa.antibiograma_id = $1
      ORDER BY a.nombre;
      `,
      [id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/antibiogramas/:id/antibioticos", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const codes = Array.isArray(req.body?.codes) ? req.body.codes : [];

    await client.query("BEGIN");
    await client.query("DELETE FROM antibiograma_antibiotico WHERE antibiograma_id=$1", [id]);

    for (const c of codes) {
      if (!c) continue;
      await client.query(
        "INSERT INTO antibiograma_antibiotico (antibiograma_id, antibiotico_codigo) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [id, String(c)]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, count: codes.length });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

app.put("/api/antibioticos/:codigo", async (req, res) => {
  try {
    const codigo = String(req.params.codigo);
    const cantidad = req.body?.cantidad;
    const stock_minimo = req.body?.stock_minimo;

    if (!Number.isInteger(cantidad) || cantidad < 0) {
      return res.status(400).json({ error: "cantidad debe ser entero >= 0" });
    }
    if (!Number.isInteger(stock_minimo) || stock_minimo < 0) {
      return res.status(400).json({ error: "stock_minimo debe ser entero >= 0" });
    }

    const r = await dbQuery(
      `UPDATE antibioticos
       SET cantidad=$1, stock_minimo=$2
       WHERE codigo=$3
       RETURNING codigo, nombre, cantidad, stock_minimo`,
      [cantidad, stock_minimo, codigo]
    );

    if (!r.rows.length) return res.status(404).json({ error: "Antibiótico no encontrado" });

    // (Correo de stock bajo eliminado)

    res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/antibioticos/:codigo/restar", async (req, res) => {
  const client = await pool.connect();
  try {
    const codigo = String(req.params.codigo);
    const n = Number(req.body?.cantidad);
    if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: "cantidad inválida" });

    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT codigo, nombre, cantidad, stock_minimo FROM antibioticos WHERE codigo=$1 FOR UPDATE",
      [codigo]
    );
    if (!cur.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Antibiótico no encontrado" });
    }

    const row = cur.rows[0];
    if (Number(row.cantidad) < n) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Stock insuficiente. Hay ${row.cantidad} y quieres restar ${n}.` });
    }

    const upd = await client.query(
      "UPDATE antibioticos SET cantidad = cantidad - $1 WHERE codigo=$2 RETURNING codigo, nombre, cantidad, stock_minimo",
      [n, codigo]
    );

    await client.query("COMMIT");

    // (Correo de stock bajo eliminado)

    res.json({ ok: true, item });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

app.post("/api/salidas", async (req, res) => {
  const client = await pool.connect();
  try {
    const antibiograma_id = Number(req.body?.antibiograma_id);
    const unidades = Number(req.body?.unidades);
    if (!Number.isInteger(antibiograma_id) || antibiograma_id <= 0) {
      return res.status(400).json({ error: "antibiograma_id inválido" });
    }
    if (!Number.isInteger(unidades) || unidades <= 0) {
      return res.status(400).json({ error: "unidades inválidas" });
    }

    await client.query("BEGIN");

    // Antibióticos asignados (bloqueo)
    const items = await client.query(
      `
      SELECT a.codigo, a.nombre, a.cantidad, a.stock_minimo
      FROM antibiograma_antibiotico aa
      JOIN antibioticos a ON a.codigo = aa.antibiotico_codigo
      WHERE aa.antibiograma_id = $1
      FOR UPDATE;
      `,
      [antibiograma_id]
    );

    if (!items.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ese antibiograma no tiene antibióticos asignados" });
    }

    // Comprobar stock
    const insuf = items.rows
      .map((r) => ({ ...r, quedaria: Number(r.cantidad) - unidades }))
      .filter((r) => r.quedaria < 0);

    if (insuf.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Stock insuficiente para registrar la salida.",
        insuficientes: insuf.map((r) => ({ codigo: r.codigo, nombre: r.nombre, cantidad: r.cantidad, pedir: unidades })),
      });
    }

    // Descontar
    for (const r of items.rows) {
      await client.query(
        "UPDATE antibioticos SET cantidad = cantidad - $1 WHERE codigo=$2",
        [unidades, r.codigo]
      );
    }

    await client.query("INSERT INTO salidas (antibiograma_id, unidades) VALUES ($1,$2)", [antibiograma_id, unidades]);

    await client.query("COMMIT");

    // (Correo de stock bajo eliminado)

    res.json({ ok: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

// --------- Frontend (estático) ---------
const frontendDir = path.join(__dirname, "..", "frontend");
app.use(express.static(frontendDir));

// Root -> login
app.get("/", (req, res) => res.sendFile(path.join(frontendDir, "index.html")));

// Fallback simple: si piden /algo y existe en frontend, lo sirve.
app.get("/:file", (req, res, next) => {
  const f = path.join(frontendDir, req.params.file);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return res.sendFile(f);
  next();
});

const PORT = process.env.PORT || 8080;
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log("✅ API + Frontend en puerto", PORT);
    });
  })
  .catch((e) => {
    console.error("❌ Error init DB:", e);
    process.exit(1);
  });
