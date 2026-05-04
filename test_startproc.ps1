$proc = Start-Process -NoNewWindow -Wait -PassThru -FilePath python -ArgumentList "-c", "import sys; sys.stderr.write('hello from stderr\n'); sys.exit(1)"
echo $proc.ExitCode
