const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const API = '/api';
let token = localStorage.getItem('rg_token'), user = null, mode = 'login';
let map, markers = [], routeLine, timer;
let trip = { pickup: null, drop: null, type: 'car', quote: null };

async function api(path, method = 'GET', body) {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401 && token) logout(); throw new Error(data.error || 'Something went wrong.'); }
  return data;
}

// ---------- auth ----------
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  mode = t.dataset.mode;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
  $('#reg-only').hidden = mode !== 'register';
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('#auth-err').textContent = '';
});
$('#auth-form [name=role]').onchange = e => $('#veh').hidden = e.target.value !== 'driver';
$('#auth-form').onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const d = await api(mode === 'login' ? '/auth/login' : '/auth/register', 'POST', f);
    token = d.token; user = d.user; localStorage.setItem('rg_token', token); start();
  } catch (err) { $('#auth-err').textContent = err.message; }
};
function logout() { token = null; user = null; localStorage.removeItem('rg_token'); clearInterval(timer); show('auth'); $('#nav').hidden = true; }
$('#btn-logout').onclick = logout;
function show(id) { $('#auth').hidden = id !== 'auth'; $('#app').hidden = id !== 'app'; if (id === 'app') setTimeout(() => map && map.invalidateSize(), 50); }

async function boot() {
  if (!token) return show('auth');
  try { user = (await api('/me')).user; start(); } catch { show('auth'); }
}
function start() {
  $('#nav').hidden = false; $('#who').textContent = `${user.name} (${user.role})`;
  show('app'); initMap(); trip = { pickup: null, drop: null, type: 'car', quote: null }; tick(); clearInterval(timer); timer = setInterval(tick, 2000);
}

// ---------- map ----------
function initMap() {
  if (map) return;
  map = L.map('map').setView([13.0827, 80.2707], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
  map.on('click', async e => {
    if (user.role !== 'rider' || activeRide) return;
    const p = { lat: e.latlng.lat, lng: e.latlng.lng, label: await reverse(e.latlng.lat, e.latlng.lng) };
    if (!trip.pickup) trip.pickup = p; else trip.drop = p;
    afterPoints();
  });
}
function drawPoints(p, d) {
  markers.forEach(m => m.remove()); markers = []; routeLine && routeLine.remove();
  const pts = [];
  if (p) { markers.push(L.circleMarker([p.lat, p.lng], { radius: 9, color: '#14201F', fillColor: '#1F7A6D', fillOpacity: 1 }).addTo(map)); pts.push([p.lat, p.lng]); }
  if (d) { markers.push(L.circleMarker([d.lat, d.lng], { radius: 9, color: '#14201F', fillColor: '#F2C230', fillOpacity: 1 }).addTo(map)); pts.push([d.lat, d.lng]); }
  if (pts.length === 2) routeLine = L.polyline(pts, { color: '#1F7A6D', weight: 4, dashArray: '8 8' }).addTo(map);
  if (pts.length) map.fitBounds(pts, { padding: [60, 60], maxZoom: 15 });
}
async function geocode(q) {
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q));
  const j = await r.json(); if (!j.length) throw new Error('No place found for "' + q + '".');
  return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name.split(',').slice(0, 2).join(',') };
}
async function reverse(lat, lng) {
  try { const j = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`)).json(); return (j.display_name || '').split(',').slice(0, 2).join(',') || `${lat.toFixed(4)}, ${lng.toFixed(4)}`; }
  catch { return `${lat.toFixed(4)}, ${lng.toFixed(4)}`; }
}

// ---------- polling ----------
let activeRide = null, lastKey = '', notice = '';
async function tick() {
  try {
    const { ride } = await api('/rides/active');
    if (user.role === 'rider' && activeRide && !ride) notice = 'Your trip is complete. Thanks for riding with RideGo!';
    activeRide = ride;
    let avail = [];
    if (user.role === 'driver' && !ride) avail = (await api('/rides/available')).rides;
    const key = JSON.stringify([ride, avail.map(a => a.id), notice]);
    if (key === lastKey) return; lastKey = key;
    user.role === 'rider' ? renderRider() : renderDriver(avail);
  } catch (e) { /* transient */ }
}

// ---------- rider ----------
const VEH = { bike: 'Bike', auto: 'Auto', car: 'Cab' };
const STAGES = ['requested', 'accepted', 'arrived', 'started', 'completed'];
function etaLine(r) {
  if (r.status === 'requested') return 'Matching you with a nearby driver…';
  if (r.status === 'accepted') return `Driver arrives in about ${r.arrive_min} min`;
  if (r.status === 'arrived') return 'Your driver is at the pickup point';
  if (r.status === 'started') return `You will reach your destination in about ${r.trip_left_min} min`;
  return '';
}
const STATUS_TEXT = { requested: 'Finding a driver…', accepted: 'Driver is on the way', arrived: 'Driver has arrived', started: 'Trip in progress', completed: 'Trip complete' };
function rideCard(r, forDriver) {
  const i = STAGES.indexOf(r.status);
  return `<span class="status">${STATUS_TEXT[r.status]}</span>
  <div class="steps">${STAGES.map((_, k) => `<i class="${k <= i ? 'done' : ''}"></i>`).join('')}</div>
  <div class="card"><p><b>From</b> ${esc(r.pickup_label)}</p><p><b>To</b> ${esc(r.drop_label)}</p><p>${r.distance_km} km · about ${r.trip_min} min trip · ${VEH[r.vehicle_type]}</p></div>
  <div class="card">${forDriver ? `<p><b>Rider</b> ${esc(r.rider_name)}</p>` : (r.driver_name ? `<p><b>Driver</b> ${esc(r.driver_name)}</p><p>${esc(r.driver_vehicle || '')}</p><p><b>${etaLine(r)}</b></p>` : `<p><b>${etaLine(r)}</b></p>`)}
  <p class="fare">₹${r.fare}</p><p>Pay in cash at the end of the trip.</p></div>`;
}
function renderRider() {
  const p = $('#panel');
  if (activeRide) {
    drawPoints({ lat: activeRide.pickup_lat, lng: activeRide.pickup_lng }, { lat: activeRide.drop_lat, lng: activeRide.drop_lng });
    p.innerHTML = `<h2>Your ride</h2>${rideCard(activeRide, false)}${['requested', 'accepted', 'arrived'].includes(activeRide.status) ? '<button class="secondary danger" id="cancel">Cancel ride</button>' : ''}`;
    const c = $('#cancel'); if (c) c.onclick = async () => { await api(`/rides/${activeRide.id}/cancel`, 'POST'); activeRide = null; lastKey = ''; tick(); };
    return;
  }
  p.innerHTML = `<h2>Book a ride</h2>${notice ? `<div class="card"><p><b>${esc(notice)}</b></p></div>` : ''}<p class="hint">Search for a place, or click the map to set pickup, then drop-off.</p>
  <div class="stop"><label>Pickup<input id="pu" value="${esc(trip.pickup?.label || '')}" placeholder="Where should we pick you up?"></label></div>
  <button class="link" id="loc" style="color:inherit;margin:-6px 0 8px 22px">Use my current location</button>
  <div class="stop drop"><label>Drop-off<input id="dr" value="${esc(trip.drop?.label || '')}" placeholder="Where are you going?"></label></div>
  <p class="err" id="err"></p><div id="quote"></div>`;
  $('#pu').onchange = e => setPoint('pickup', e.target.value); $('#dr').onchange = e => setPoint('drop', e.target.value);
  $('#loc').onclick = () => navigator.geolocation?.getCurrentPosition(async pos => { trip.pickup = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: await reverse(pos.coords.latitude, pos.coords.longitude) }; afterPoints(); }, () => $('#err').textContent = 'Location access was blocked. Search for your pickup instead.');
  drawPoints(trip.pickup, trip.drop); showQuote();
}
async function setPoint(k, q) { if (!q.trim()) return; try { trip[k] = await geocode(q); afterPoints(); } catch (e) { $('#err').textContent = e.message; } }
async function afterPoints() {
  trip.quote = null; lastKey = ''; renderRider();
  if (trip.pickup && trip.drop) { try { trip.quote = await api('/rides/estimate', 'POST', { pickup: trip.pickup, drop: trip.drop }); } catch (e) { $('#err').textContent = e.message; } showQuote(); }
}
function showQuote() {
  const q = trip.quote; if (!q) return;
  $('#quote').innerHTML = `<p class="hint">${q.distance_km} km</p><div class="opts">${Object.entries(q.fares).map(([t, f]) =>
    `<button class="opt ${trip.type === t ? 'on' : ''}" data-t="${t}"><span>${VEH[t]} · ${q.minutes[t]} min</span><b>₹${f}</b></button>`).join('')}</div>
    <button class="primary" id="req">Request ${VEH[trip.type]}</button>`;
  document.querySelectorAll('.opt').forEach(b => b.onclick = () => { trip.type = b.dataset.t; showQuote(); });
  $('#req').onclick = async () => { try { notice = ''; await api('/rides', 'POST', { pickup: trip.pickup, drop: trip.drop, vehicle_type: trip.type }); trip = { pickup: null, drop: null, type: 'car', quote: null }; lastKey = ''; tick(); } catch (e) { $('#err').textContent = e.message; } };
}

// ---------- driver ----------
function renderDriver(avail) {
  const p = $('#panel');
  if (activeRide) {
    drawPoints({ lat: activeRide.pickup_lat, lng: activeRide.pickup_lng }, { lat: activeRide.drop_lat, lng: activeRide.drop_lng });
    const label = { accepted: 'I have arrived', arrived: 'Start trip', started: 'Complete trip' }[activeRide.status];
    p.innerHTML = `<h2>Current ride</h2>${rideCard(activeRide, true)}<button class="primary" id="adv">${label}</button>
      ${activeRide.status !== 'started' ? '<button class="secondary danger" id="cancel" style="margin-top:8px">Drop this ride</button>' : ''}<p class="err" id="err"></p>`;
    $('#adv').onclick = async () => { try { await api(`/rides/${activeRide.id}/advance`, 'POST'); lastKey = ''; tick(); } catch (e) { $('#err').textContent = e.message; } };
    const c = $('#cancel'); if (c) c.onclick = async () => { await api(`/rides/${activeRide.id}/cancel`, 'POST'); lastKey = ''; tick(); };
    return;
  }
  markers.forEach(m => m.remove()); routeLine && routeLine.remove();
  p.innerHTML = `<h2>Ride requests</h2><p class="hint">New requests appear here automatically.</p>` +
    (avail.length ? avail.map(r => `<div class="card"><p><b>${esc(r.pickup_label)}</b></p><p>to ${esc(r.drop_label)}</p><p>${r.distance_km} km · ${r.trip_min} min · ${VEH[r.vehicle_type]} · <b>₹${r.fare}</b></p>
      <button class="primary" data-id="${r.id}" data-pu="${r.pickup_lat},${r.pickup_lng}">Accept</button></div>`).join('') : '<p>No requests right now. Stay on this page and we will show new ones.</p>') + '<p class="err" id="err"></p>';
  p.querySelectorAll('button[data-id]').forEach(b => {
    b.onmouseenter = () => { const [a, c] = b.dataset.pu.split(',').map(Number); map.setView([a, c], 14); };
    b.onclick = async () => { try { await api(`/rides/${b.dataset.id}/accept`, 'POST'); lastKey = ''; tick(); } catch (e) { $('#err').textContent = e.message; lastKey = ''; tick(); } };
  });
}

// ---------- history ----------
$('#btn-history').onclick = async () => {
  const { rides } = await api('/rides/history');
  $('#history-list').innerHTML = rides.length ? rides.map(r => `<div class="card"><p><b>${esc(r.pickup_label)}</b> to ${esc(r.drop_label)}</p><p>${new Date(r.created_at + 'Z').toLocaleString()} · ${r.status} · ₹${r.fare}</p></div>`).join('') : '<p>No finished trips yet.</p>';
  $('#history').showModal();
};
boot();
