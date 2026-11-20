PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('rider','driver')),
  vehicle TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  driver_id INTEGER REFERENCES users(id),
  pickup_label TEXT, pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL,
  drop_label TEXT,   drop_lat REAL NOT NULL,   drop_lng REAL NOT NULL,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('bike','auto','car')),
  distance_km REAL NOT NULL,
  fare REAL NOT NULL,
  duration_min INTEGER,
  pickup_eta_min INTEGER,
  auto INTEGER NOT NULL DEFAULT 0,
  auto_driver_name TEXT, auto_driver_vehicle TEXT,
  t_arrive INTEGER, t_start INTEGER, t_end INTEGER,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','accepted','arrived','started','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_rider ON rides(rider_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id);
