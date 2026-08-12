export DWS_HOST="${DWS_HOST}"
export DWS_PORT="${DWS_PORT}"
export DWS_DBNAME="${DWS_DBNAME}"
export DWS_USER="${DWS_USER}"
export DWS_PASSWORD="${DWS_PASSWORD}"
export DWS_SCHEMA="public"

# Create a proper MCP initialize request with Content-Length header
printf 'Content-Length: 42\r\n\r\n{"jsonrpc":"2.0","method":"initialize","id":1}' | \
  /usr/bin/python3 /home/dp-user/dataprojv2/dws_mcp_server.py 2>_mcp_stderr.txt

echo "--- stderr ---"
cat _mcp_stderr.txt
