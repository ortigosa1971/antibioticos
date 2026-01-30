CREATE TABLE IF NOT EXISTS antibiogramas (
  id SERIAL PRIMARY KEY,
  nombre TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS antibioticos (
  codigo TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  cantidad INT NOT NULL DEFAULT 0,
  stock_minimo INT NOT NULL DEFAULT 0
);

-- Compatibilidad: si la tabla ya existe sin estas columnas.
ALTER TABLE antibioticos ADD COLUMN IF NOT EXISTS cantidad INT NOT NULL DEFAULT 0;
ALTER TABLE antibioticos ADD COLUMN IF NOT EXISTS stock_minimo INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS antibiograma_antibiotico (
  antibiograma_id INT NOT NULL REFERENCES antibiogramas(id) ON DELETE CASCADE,
  antibiotico_codigo TEXT NOT NULL REFERENCES antibioticos(codigo) ON DELETE CASCADE,
  PRIMARY KEY (antibiograma_id, antibiotico_codigo)
);
