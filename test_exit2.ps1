$global:LASTEXITCODE = 0
Test-Path "does_not_exist.txt" | Out-Null
echo $LASTEXITCODE
