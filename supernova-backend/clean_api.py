import re
with open('api_server.py', 'r') as f:
    content = f.read()

# Fix unmatched parenthesis
content = re.sub(r'from getDataProcedure import \(\n\)', '', content, flags=re.MULTILINE)
content = re.sub(r'from db_connection import create_connection\n\)', '', content, flags=re.MULTILINE)
content = content.replace(')', '', 1) # wait, I don't know exactly what line 334 looks like. Let's just restore from backup and use a smarter replace.

