import re

with open('api_server.py', 'r') as f:
    content = f.read()

# I will replace the broken import block around line 3089
content = re.sub(
    r'convert_readable_path_to_oracle_like,\s*detect_point_type_from_path,\s*read_data_aggregated,\s*read_raw_data_combined,\s*parse_datetime_string\s*\)',
    '',
    content
)

with open('api_server.py', 'w') as f:
    f.write(content)
