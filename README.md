# Supernova (super_nov4) 🚀

Supernova is a full-stack industrial SCADA & data analysis platform featuring an Angular frontend UI, Python backend services, dynamic report generation, and database management engines.

## 📁 Repository Structure

- **`supernova-ui/`**: Angular frontend application with dashboard components, report tools, theme customization, and workspace.
- **`supernova-backend/`**: Python API backend services, path engines, Excel template engine, and report executors.
- **`supernova-gh-pages/`**: Web export / static mock database & UI artifacts.
- **`db/`**: Database configuration and SQLite storage engine.

## 🛠️ Getting Started

### Backend
```bash
cd supernova-backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python api_server.py
```

### Frontend
```bash
cd supernova-ui
npm install
npm start
```

## 👥 Contributors

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for the list of contributors.
