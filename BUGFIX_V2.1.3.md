# v2.1.3 - Critical Bug Fix

**Published**: November 7, 2025

## Bug Fixed

### Login Path Mismatch

**Issue**: `biofs login` saved credentials to wrong directory

**Root Cause**:
```typescript
// constants.ts (BEFORE - WRONG!)
CONFIG_DIR_NAME: '.genobank'  // ❌ Wrong path!

// All other commands expected:
~/.biofs/credentials.json  // ✅ Correct path
```

**Result**: Login appeared to work, but all commands failed with:
```
Error: ENOENT: no such file or directory, open '~/.biofs/credentials.json'
```

**Fix**:
```typescript
// constants.ts (AFTER - FIXED!)
CONFIG_DIR_NAME: '.biofs'  // ✅ Correct path!
```

**Files Changed**:
- `src/lib/config/constants.ts` - Line 20: `.genobank` → `.biofs`
- `src/commands/login.ts` - Lines 54, 116: Updated success messages

## How to Update

```bash
npm install -g @genobank/biofs@2.1.3
```

Now all commands work properly:
```bash
biofs login      # ✅ Saves to ~/.biofs/credentials.json
biofs dissect    # ✅ Finds credentials at ~/.biofs/credentials.json
biofs tokenize   # ✅ Works!
biofs share      # ✅ Works!
```

## Testing

```bash
# Clean install
rm -rf ~/.biofs ~/.genobank

# Install latest
npm install -g @genobank/biofs@2.1.3

# Login
biofs login

# Verify credentials saved correctly
ls -la ~/.biofs/credentials.json
# Should exist! ✅

# Test command
biofs whoami
# Should show your wallet ✅
```

## Apologies

This bug prevented v2.1.0-2.1.2 from working properly. Thank you for catching it! v2.1.3 is now fully functional.
