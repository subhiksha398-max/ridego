# RideGo – ride-hailing web app

Folders
- frontend/  static site (HTML, CSS, JS, Leaflet + OpenStreetMap)
- backend/   Node.js + Express REST API (JWT auth)
- database/  schema.sql (SQLite; ridego.db is created on first run)

Run
    cd backend
    npm install
    npm start
Open http://localhost:3000 (backend serves the frontend).

Try it: register a rider, set pickup + drop-off, choose a vehicle and request.
A driver is matched instantly. If a real driver account is online and free, that driver gets the ride and moves it
through arrived, started, completed. Otherwise a demo driver is assigned and the trip plays out automatically.
The screen shows driver arrival time and trip time (distance / average speed: bike 30, auto 25, cab 28 km/h).

Config (env vars): PORT, JWT_SECRET (set a strong one), DB_PATH, DEMO_SPEED (default 12: demo trips run 12x faster; 1 = real time).
Not included yet: online payments, live driver GPS, push notifications, admin panel.
