export DWS_HOST="121.37.200.214"
export DWS_PORT="8000"
export DWS_DBNAME="DP_DWS"
export DWS_USER="aiuser"
export DWS_PASSWORD="Dp123456"
export DWS_SCHEMA="public"

# Create a proper MCP initialize request with Content-Length header
printf 'Content-Length: 42\r\n\r\n{"jsonrpc":"2.0","method":"initialize","id":1}' | \
  C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe D:/dataproj/dws_mcp_server.py 2>_mcp_stderr.txt

echo "--- stderr ---"
cat _mcp_stderr.txt
