const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'database', 'ridego.db');

const db = new Database(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
// upgrade older ridego.db files that were created before auto-matching existed
{
  const have = db.prepare('PRAGMA table_info(rides)').all().map(c => c.name);
  const need = { duration_min: 'INTEGER', pickup_eta_min: 'INTEGER', auto: 'INTEGER NOT NULL DEFAULT 0', auto_driver_name: 'TEXT',
    auto_driver_vehicle: 'TEXT', t_arrive: 'INTEGER', t_start: 'INTEGER', t_end: 'INTEGER' };
  for (const [n, t] of Object.entries(need)) if (!have.includes(n)) db.exec(`ALTER TABLE rides ADD COLUMN ${n} ${t}`);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---- fares (INR) ----
const RATES = { bike: { base: 25, km: 7 }, auto: { base: 35, km: 11 }, car: { base: 50, km: 15 } };
function haversine(a, b, c, d) {
  const R = 6371, r = x => x * Math.PI / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3; // 1.3 = road factor
}
// ---- travel time ----
const SPEED_KMH = { bike: 30, auto: 25, car: 28 };      // average city speeds
const tripMinutes = (km, t) => Math.max(3, Math.round(km / SPEED_KMH[t] * 60));
// Demo drivers move faster than real life so you can watch a whole trip quickly.
// 12 = one trip-minute plays in 5 seconds. Set DEMO_SPEED=1 for real time.
const DEMO_SPEED = Number(process.env.DEMO_SPEED) || 12;
function quote(p, d) {
  const km = haversine(p.lat, p.lng, d.lat, d.lng);
  const fares = {}, minutes = {};
  for (const [t, r] of Object.entries(RATES)) { fares[t] = Math.round(r.base + r.km * km); minutes[t] = tripMinutes(km, t); }
  return { distance_km: +km.toFixed(2), fares, minutes };
}

const seen = new Map(); // driver id -> last time their app contacted the server
// ---- auth ----
const sign = u => jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '7d' });
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, vehicle: u.vehicle });
function auth(role) {
  return (req, res, next) => {
    try {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      const p = jwt.verify(t, SECRET);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(p.id);
      if (!u) throw new Error();
      if (role && u.role !== role) return res.status(403).json({ error: `Only ${role}s can do this.` });
      if (u.role === 'driver') seen.set(u.id, Date.now());
      req.user = u; next();
    } catch { res.status(401).json({ error: 'Please log in.' }); }
  };
}

app.post('/api/auth/register', (req, res) => {
  const { name, email, password, role, vehicle } = req.body || {};
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Name, email and a password of 6+ characters are required.' });
  if (!['rider', 'driver'].includes(role)) return res.status(400).json({ error: 'Choose rider or driver.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) return res.status(409).json({ error: 'That email is already registered.' });
  const info = db.prepare('INSERT INTO users (name,email,password_hash,role,vehicle) VALUES (?,?,?,?,?)')
    .run(name.trim(), email.toLowerCase(), bcrypt.hashSync(password, 10), role, role === 'driver' ? (vehicle || null) : null);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ token: sign(u), user: pub(u) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  res.json({ token: sign(u), user: pub(u) });
});

app.get('/api/me', auth(), (req, res) => res.json({ user: pub(req.user) }));

// ---- rides ----
const rideSql = `SELECT r.*, rd.name AS rider_name, COALESCE(dr.name, r.auto_driver_name) AS driver_name, COALESCE(dr.vehicle, r.auto_driver_vehicle) AS driver_vehicle
  FROM rides r JOIN users rd ON rd.id = r.rider_id LEFT JOIN users dr ON dr.id = r.driver_id`;
const LIVE = "('requested','accepted','arrived','started')";

// ---- instant driver matching ----
const DEMO_NAMES = ['Murugan', 'Karthik', 'Selvam', 'Prakash', 'Anbu', 'Senthil', 'Vignesh', 'Ravi', 'Mani', 'Arun'];
const DEMO_VEH = { bike: ['Honda Shine', 'TVS Apache', 'Bajaj Pulsar'], auto: ['Bajaj RE Auto', 'Piaggio Ape Auto'], car: ['Maruti Dzire', 'Hyundai Aura', 'Toyota Etios'] };
const pick = a => a[Math.floor(Math.random() * a.length)];
const L = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
const plate = () => `TN ${pick(['58', '59', '09', '07'])} ${L()}${L()} ${1000 + Math.floor(Math.random() * 9000)}`;

function freeOnlineDriver(exclude) {
  const rows = db.prepare(`SELECT id FROM users WHERE role='driver' AND id != ? AND id NOT IN
    (SELECT driver_id FROM rides WHERE driver_id IS NOT NULL AND status IN ${LIVE})`).all(exclude || 0);
  return rows.find(r => Date.now() - (seen.get(r.id) || 0) < 15000);
}
// Give the ride a driver right away: a real driver who is online and free, otherwise a demo driver.
function assign(ride, exclude) {
  const eta = 3 + Math.floor(Math.random() * 5);       // driver reaches pickup in 3-7 min
  const dur = ride.duration_min || tripMinutes(ride.distance_km, ride.vehicle_type);
  const d = freeOnlineDriver(exclude);
  if (d) {
    db.prepare(`UPDATE rides SET driver_id=?, status='accepted', duration_min=?, pickup_eta_min=?, auto=0, auto_driver_name=NULL, auto_driver_vehicle=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(d.id, dur, eta, ride.id);
  } else {
    const per = 60000 / DEMO_SPEED, now = Date.now();
    const tArrive = now + eta * per, tStart = tArrive + per, tEnd = tStart + dur * per;
    db.prepare(`UPDATE rides SET driver_id=NULL, status='accepted', duration_min=?, pickup_eta_min=?, auto=1, auto_driver_name=?, auto_driver_vehicle=?, t_arrive=?, t_start=?, t_end=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(dur, eta, pick(DEMO_NAMES), `${pick(DEMO_VEH[ride.vehicle_type])} ${plate()}`, tArrive, tStart, tEnd, ride.id);
  }
}
// Move demo rides through arrived -> started -> completed on their own, and match any ride still waiting.
function syncAll() {
  for (const r of db.prepare("SELECT * FROM rides WHERE status='requested'").all()) assign(r);
  const now = Date.now();
  for (const r of db.prepare("SELECT * FROM rides WHERE auto=1 AND status IN ('accepted','arrived','started')").all()) {
    const s = now >= r.t_end ? 'completed' : now >= r.t_start ? 'started' : now >= r.t_arrive ? 'arrived' : 'accepted';
    if (s !== r.status) db.prepare('UPDATE rides SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(s, r.id);
  }
}
// Adds the minutes the screen shows: driver arrival, whole trip, and trip time still left.
function fx(r) {
  if (!r) return r;
  const now = Date.now(), per = 60000 / DEMO_SPEED;
  const dur = r.duration_min || tripMinutes(r.distance_km, r.vehicle_type);
  let arrive = r.pickup_eta_min || 0, left = dur;
  if (r.auto) {
    arrive = r.status === 'accepted' ? Math.max(1, Math.ceil((r.t_arrive - now) / per)) : 0;
    if (r.status === 'started') left = Math.max(1, Math.ceil((r.t_end - now) / per));
  } else {
    if (r.status !== 'accepted') arrive = 0;
    if (r.status === 'started') left = Math.max(1, Math.ceil(dur - (now - Date.parse(r.updated_at.replace(' ', 'T') + 'Z')) / 60000));
  }
  return { ...r, trip_min: dur, arrive_min: arrive, trip_left_min: left };
}
app.use('/api/rides', (req, res, next) => { syncAll(); next(); });

app.post('/api/rides/estimate', auth('rider'), (req, res) => {
  const { pickup, drop } = req.body || {};
  if (!pickup || !drop) return res.status(400).json({ error: 'Pickup and drop-off are required.' });
  res.json(quote(pickup, drop));
});

app.post('/api/rides', auth('rider'), (req, res) => {
  const { pickup, drop, vehicle_type } = req.body || {};
  if (!pickup || !drop || !RATES[vehicle_type]) return res.status(400).json({ error: 'Pickup, drop-off and vehicle type are required.' });
  if (db.prepare(`SELECT 1 FROM rides WHERE rider_id = ? AND status IN ${LIVE}`).get(req.user.id))
    return res.status(409).json({ error: 'You already have a ride in progress.' });
  const q = quote(pickup, drop);
  const info = db.prepare(`INSERT INTO rides (rider_id,pickup_label,pickup_lat,pickup_lng,drop_label,drop_lat,drop_lng,vehicle_type,distance_km,fare,duration_min)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, pickup.label || null, pickup.lat, pickup.lng, drop.label || null, drop.lat, drop.lng, vehicle_type, q.distance_km, q.fares[vehicle_type], q.minutes[vehicle_type]);
  assign(db.prepare('SELECT * FROM rides WHERE id = ?').get(info.lastInsertRowid));
  res.json({ ride: fx(db.prepare(rideSql + ' WHERE r.id = ?').get(info.lastInsertRowid)) });
});

app.get('/api/rides/active', auth(), (req, res) => {
  const col = req.user.role === 'rider' ? 'r.rider_id' : 'r.driver_id';
  res.json({ ride: fx(db.prepare(`${rideSql} WHERE ${col} = ? AND r.status IN ${LIVE} ORDER BY r.id DESC LIMIT 1`).get(req.user.id)) || null });
});

app.get('/api/rides/history', auth(), (req, res) => {
  const col = req.user.role === 'rider' ? 'r.rider_id' : 'r.driver_id';
  res.json({ rides: db.prepare(`${rideSql} WHERE ${col} = ? AND r.status IN ('completed','cancelled') ORDER BY r.id DESC LIMIT 50`).all(req.user.id).map(fx) });
});

app.get('/api/rides/available', auth('driver'), (req, res) =>
  res.json({ rides: db.prepare(`${rideSql} WHERE r.status = 'requested' ORDER BY r.id DESC LIMIT 30`).all().map(fx) }));

app.post('/api/rides/:id/accept', auth('driver'), (req, res) => {
  if (db.prepare(`SELECT 1 FROM rides WHERE driver_id = ? AND status IN ${LIVE}`).get(req.user.id))
    return res.status(409).json({ error: 'Finish your current ride first.' });
  const r = db.prepare(`UPDATE rides SET driver_id=?, status='accepted', auto=0, pickup_eta_min=4, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='requested'`).run(req.user.id, req.params.id);
  if (!r.changes) return res.status(409).json({ error: 'This ride was already taken or cancelled.' });
  res.json({ ride: fx(db.prepare(rideSql + ' WHERE r.id = ?').get(req.params.id)) });
});

const NEXT = { accepted: 'arrived', arrived: 'started', started: 'completed' };
app.post('/api/rides/:id/advance', auth('driver'), (req, res) => {
  const ride = db.prepare('SELECT * FROM rides WHERE id = ? AND driver_id = ?').get(req.params.id, req.user.id);
  if (!ride || !NEXT[ride.status]) return res.status(409).json({ error: 'This ride cannot move forward.' });
  db.prepare('UPDATE rides SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(NEXT[ride.status], ride.id);
  res.json({ ride: fx(db.prepare(rideSql + ' WHERE r.id = ?').get(ride.id)) });
});

app.post('/api/rides/:id/cancel', auth(), (req, res) => {
  const col = req.user.role === 'rider' ? 'rider_id' : 'driver_id';
  const ride = db.prepare(`SELECT * FROM rides WHERE id = ? AND ${col} = ?`).get(req.params.id, req.user.id);
  if (!ride || ['started', 'completed', 'cancelled'].includes(ride.status)) return res.status(409).json({ error: 'This ride can no longer be cancelled.' });
  if (req.user.role === 'driver') { // driver dropped it: find the rider another driver straight away
    db.prepare("UPDATE rides SET driver_id=NULL, status='requested', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(ride.id);
    assign(db.prepare('SELECT * FROM rides WHERE id = ?').get(ride.id), req.user.id);
  }
  else db.prepare("UPDATE rides SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(ride.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`RideGo running at http://localhost:${PORT}`));
