$global:LASTEXITCODE = 1
python -c 'import sys; sys.exit(0)'
echo $LASTEXITCODE
