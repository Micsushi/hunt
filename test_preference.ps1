$ErrorActionPreference = "Continue"
python -c "import sys; sys.stderr.write('hello stderr\n')"
exit $LASTEXITCODE
