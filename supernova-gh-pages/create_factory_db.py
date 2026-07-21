import sqlite3
import json
import os

def create_factory_db():
    db_path = 'factory_mock.sqlite'
    if os.path.exists(db_path):
        os.remove(db_path)
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Create tables
    cursor.execute('''
    CREATE TABLE locations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
    )
    ''')
    
    cursor.execute('''
    CREATE TABLE production_lines (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        location_id INTEGER,
        FOREIGN KEY(location_id) REFERENCES locations(id)
    )
    ''')
    
    cursor.execute('''
    CREATE TABLE machines (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        line_id INTEGER,
        status TEXT,
        FOREIGN KEY(line_id) REFERENCES production_lines(id)
    )
    ''')
    
    # Insert Data: Locations (B1)
    locations = [
        (1, 'Plant Alpha - Assembly'),
        (2, 'Plant Beta - Packaging'),
        (3, 'Plant Gamma - Paint Shop')
    ]
    cursor.executemany('INSERT INTO locations VALUES (?, ?)', locations)
    
    # Insert Data: Production Lines (B2)
    lines = [
        (1, 'Chassis Assembly Line', 1),
        (2, 'Engine Assembly Line', 1),
        (3, 'Electronics Assembly', 1),
        (4, 'Primary Packaging', 2),
        (5, 'Secondary Packaging', 2),
        (6, 'Base Coat Line', 3),
        (7, 'Clear Coat Line', 3)
    ]
    cursor.executemany('INSERT INTO production_lines VALUES (?, ?, ?)', lines)
    
    # Insert Data: Machines (B3)
    machines = [
        # Chassis
        (1, 'KUKA Robot Arm C1', 'Robot', 1, 'online'),
        (2, 'KUKA Robot Arm C2', 'Robot', 1, 'online'),
        (3, 'Conveyor Belt C-Main', 'Conveyor', 1, 'warning'),
        (4, 'Siemens S7 PLC C1', 'Controller', 1, 'online'),
        # Engine
        (5, 'CNC Lathe E1', 'CNC', 2, 'alarm'),
        (6, 'CNC Lathe E2', 'CNC', 2, 'offline'),
        (7, 'Torque Station E1', 'Tool', 2, 'online'),
        (8, 'Engine Testing Rig', 'Test', 2, 'online'),
        (9, 'Siemens S7 PLC E1', 'Controller', 2, 'online'),
        # Electronics
        (10, 'Pick and Place M1', 'Robot', 3, 'online'),
        (11, 'Reflow Oven', 'Heater', 3, 'warning'),
        (12, 'Optical Inspection', 'Sensor', 3, 'online'),
        # Primary Packaging
        (13, 'Box Erector P1', 'Packaging', 4, 'online'),
        (14, 'Sealing Machine P1', 'Packaging', 4, 'online'),
        # Secondary Packaging
        (15, 'Palletizer Robot R1', 'Robot', 5, 'online'),
        (16, 'Stretch Wrapper', 'Packaging', 5, 'offline'),
        # Base Coat
        (17, 'Paint Robot Spray 1', 'Robot', 6, 'alarm'),
        (18, 'Paint Robot Spray 2', 'Robot', 6, 'online'),
        (19, 'Drying Oven 1', 'Heater', 6, 'warning'),
        # Clear Coat
        (20, 'Clear Coat Sprayer', 'Robot', 7, 'online'),
        (21, 'Drying Oven 2', 'Heater', 7, 'online')
    ]
    cursor.executemany('INSERT INTO machines VALUES (?, ?, ?, ?, ?)', machines)
    
    conn.commit()
    
    print("Database 'factory_mock.sqlite' created successfully!")
    
    # Generate the query that the UI will "run"
    sql_query = """
SELECT 
  'loc_' || l.id as id,
  l.name as label,
  0 as depth,
  NULL as parent
FROM locations l
UNION ALL
SELECT 
  'line_' || pl.id as id,
  pl.name as label,
  1 as depth,
  'loc_' || pl.location_id as parent
FROM production_lines pl
UNION ALL
SELECT 
  'mach_' || m.id as id,
  m.name as label,
  2 as depth,
  'line_' || m.line_id as parent
FROM machines m
    """
    
    # Execute the query to build the JSON tree
    cursor.execute(sql_query)
    rows = cursor.fetchall()
    
    nodes = []
    for row in rows:
        nodes.append({
            'id': row[0],
            'label': row[1],
            'depth': row[2],
            'parent': row[3]
        })
        
    # Write to a JSON file for the Angular Mock Interceptor
    mock_json_path = 'ui/src/assets/mock-factory.json'
    os.makedirs(os.path.dirname(mock_json_path), exist_ok=True)
    with open(mock_json_path, 'w') as f:
        json.dump(nodes, f, indent=2)
        
    print(f"Mock JSON data written to '{mock_json_path}'")
    
    conn.close()

if __name__ == '__main__':
    create_factory_db()
