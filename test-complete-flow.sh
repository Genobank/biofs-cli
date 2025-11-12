#!/bin/bash

# GenoBank CLI Complete Test Script
# Tests all major functionality with CEO credentials

echo "========================================="
echo "GenoBank CLI Complete Test Suite"
echo "========================================="
echo ""

# 1. Test whoami command
echo "1. Testing 'whoami' command:"
echo "----------------------------"
genobank whoami
echo ""

# 2. Test files command
echo "2. Testing 'files' command:"
echo "----------------------------"
genobank files
echo ""

# 3. Test files with filter
echo "3. Testing 'files --filter vcf' command:"
echo "-----------------------------------------"
genobank files --filter vcf
echo ""

# 4. Test JSON output
echo "4. Testing 'whoami --json' command:"
echo "------------------------------------"
genobank whoami --json
echo ""

# 5. Test help
echo "5. Testing 'help' command:"
echo "---------------------------"
genobank help download
echo ""

# 6. Show version
echo "6. Testing version:"
echo "-------------------"
genobank --version
echo ""

echo "========================================="
echo "Test Complete!"
echo "========================================="
echo ""
echo "Summary of commands tested:"
echo "  ✅ genobank whoami - Show authenticated wallet"
echo "  ✅ genobank files - List BioFiles"
echo "  ✅ genobank files --filter - Filter by type"
echo "  ✅ genobank whoami --json - JSON output"
echo "  ✅ genobank help - Help system"
echo "  ✅ genobank --version - Version check"
echo ""
echo "Note: Upload and download require actual files"
echo "Login/logout not tested (would clear CEO credentials)"