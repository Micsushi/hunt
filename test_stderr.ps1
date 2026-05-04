python -c "import sys; sys.stderr.write('hello from stderr\n')" 2>&1 | ForEach-Object { "$_" }
echo $LASTEXITCODE
