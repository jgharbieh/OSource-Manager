@echo off
rem CLI shim — `osm <command>` from anywhere once this folder is on PATH.
node "%~dp0dist\cli.js" %*
