"""
BioFS Researcher Registration — CherryPy endpoints for runweb.py

Insert these methods into the main CherryPy class (after api_biofs_telemetry_query).
Also add the config block at the bottom to the cherrypy.tree.mount() section.

Dependencies (pip install on prod):
  - eth-account>=0.13.0
  - cryptography>=42.0

Env vars (add to /home/ubuntu/.env):
  ORCID_CLIENT_ID=APP-XXXXXXXXXX
  ORCID_CLIENT_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
  GOOGLE_CLIENT_SECRET=xxxxx
  LINKEDIN_CLIENT_ID=xxxxxx
  LINKEDIN_CLIENT_SECRET=xxxxxx
  TWITTER_CLIENT_ID=xxxxxx
  TWITTER_CLIENT_SECRET=xxxxxx
  APPLE_CLIENT_ID=io.genobank.researcher
  APPLE_TEAM_ID=XXXXXXXXXX
  APPLE_KEY_ID=XXXXXXXXXX
  APPLE_PRIVATE_KEY_PATH=/home/ubuntu/.apple_signin_key.p8

MongoDB collection: biofs_researchers (in genobank-api DB)
Wallet master key: /home/ubuntu/.somos_wallet_master_key (Fernet, already exists)
"""

import json
import os
import base64
import hashlib
import time
import traceback
from datetime import datetime, timezone

import cherrypy
import requests
from eth_account import Account
from eth_account.messages import encode_defunct
from cryptography.fernet import Fernet

# ---------------------------------------------------------------------------
# OAuth provider configurations
# ---------------------------------------------------------------------------

OAUTH_PROVIDERS = {
    'orcid': {
        'auth_url':  'https://orcid.org/oauth/authorize',
        'token_url': 'https://orcid.org/oauth/token',
        'userinfo_url': None,  # user info comes in the token response
        'scopes': '/authenticate',
        'client_id_env': 'ORCID_CLIENT_ID',
        'client_secret_env': 'ORCID_CLIENT_SECRET',
    },
    'google': {
        'auth_url':  'https://accounts.google.com/o/oauth2/v2/auth',
        'token_url': 'https://oauth2.googleapis.com/token',
        'userinfo_url': 'https://www.googleapis.com/oauth2/v3/userinfo',
        'scopes': 'openid email profile',
        'client_id_env': 'GOOGLE_CLIENT_ID',
        'client_secret_env': 'GOOGLE_CLIENT_SECRET',
    },
    'linkedin': {
        'auth_url':  'https://www.linkedin.com/oauth/v2/authorization',
        'token_url': 'https://www.linkedin.com/oauth/v2/accessToken',
        'userinfo_url': 'https://api.linkedin.com/v2/userinfo',
        'scopes': 'openid profile email',
        'client_id_env': 'LINKEDIN_CLIENT_ID',
        'client_secret_env': 'LINKEDIN_CLIENT_SECRET',
    },
    'twitter': {
        'auth_url':  'https://twitter.com/i/oauth2/authorize',
        'token_url': 'https://api.twitter.com/2/oauth2/token',
        'userinfo_url': 'https://api.twitter.com/2/users/me',
        'scopes': 'users.read tweet.read',
        'client_id_env': 'TWITTER_CLIENT_ID',
        'client_secret_env': 'TWITTER_CLIENT_SECRET',
        'pkce': True,
    },
    'apple': {
        'auth_url':  'https://appleid.apple.com/auth/authorize',
        'token_url': 'https://appleid.apple.com/auth/token',
        'userinfo_url': None,  # user info comes in the id_token
        'scopes': 'name email',
        'client_id_env': 'APPLE_CLIENT_ID',
        'client_secret_env': None,  # Apple uses JWT client secret
    },
}

OAUTH_REDIRECT_URI = 'https://genobank.app/api_biofs_researcher_oauth_callback'
RESEARCHER_REGISTER_PAGE = 'https://genobank.io/researcher/register/'
MESSAGE_TO_SIGN = 'I want to proceed'


def _load_fernet():
    """Load the Fernet key used to encrypt custodial wallet private keys."""
    key_path = os.environ.get(
        'WALLET_MASTER_KEY_PATH', '/home/ubuntu/.somos_wallet_master_key'
    )
    with open(key_path, 'rb') as f:
        return Fernet(f.read().strip())


def _get_or_create_researcher_wallet(db, provider, provider_id, profile_data):
    """
    Look up an existing custodial wallet for this provider+id.
    If none exists, generate a new one (Account.create()), encrypt the
    private key, and store in biofs_researchers.
    Returns (wallet_address, signature_of_I_want_to_proceed).
    """
    coll = db['biofs_researchers']

    existing = coll.find_one({
        'provider': provider,
        'provider_id': provider_id
    })

    fernet = _load_fernet()

    if existing:
        # Decrypt private key and sign
        priv = fernet.decrypt(existing['encrypted_private_key']).decode()
        acct = Account.from_key(priv)
        msg = encode_defunct(text=MESSAGE_TO_SIGN)
        sig = acct.sign_message(msg)

        # Update last_login
        coll.update_one(
            {'_id': existing['_id']},
            {'$set': {
                'last_login_at': datetime.now(timezone.utc).isoformat(),
                'name': profile_data.get('name') or existing.get('name', ''),
                'email': profile_data.get('email') or existing.get('email', ''),
            }}
        )

        return existing['wallet_address'], '0x' + sig.signature.hex()

    # Create new custodial wallet
    acct = Account.create()
    encrypted_key = fernet.encrypt(acct.key.hex().encode())
    msg = encode_defunct(text=MESSAGE_TO_SIGN)
    sig = acct.sign_message(msg)

    doc = {
        'wallet_address': acct.address,
        'provider': provider,
        'provider_id': str(provider_id),
        'name': profile_data.get('name', ''),
        'email': profile_data.get('email', ''),
        'orcid_id': profile_data.get('orcid_id', ''),
        'institution': profile_data.get('institution', ''),
        'encrypted_private_key': encrypted_key,
        'registered_at': datetime.now(timezone.utc).isoformat(),
        'last_login_at': datetime.now(timezone.utc).isoformat(),
    }

    coll.insert_one(doc)

    return acct.address, '0x' + sig.signature.hex()


# ---------------------------------------------------------------------------
# OAuth token exchange helpers per provider
# ---------------------------------------------------------------------------

def _exchange_orcid(code, client_id, client_secret):
    """Exchange ORCID auth code for user profile."""
    r = requests.post(OAUTH_PROVIDERS['orcid']['token_url'], data={
        'client_id': client_id,
        'client_secret': client_secret,
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': OAUTH_REDIRECT_URI,
    }, headers={'Accept': 'application/json'}, timeout=15)
    r.raise_for_status()
    data = r.json()
    return {
        'id': data.get('orcid', ''),
        'name': data.get('name', ''),
        'email': '',
        'orcid_id': data.get('orcid', ''),
    }


def _exchange_google(code, client_id, client_secret):
    r = requests.post(OAUTH_PROVIDERS['google']['token_url'], data={
        'client_id': client_id,
        'client_secret': client_secret,
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': OAUTH_REDIRECT_URI,
    }, timeout=15)
    r.raise_for_status()
    token = r.json()['access_token']

    u = requests.get(OAUTH_PROVIDERS['google']['userinfo_url'],
                     headers={'Authorization': f'Bearer {token}'}, timeout=10)
    u.raise_for_status()
    info = u.json()
    return {
        'id': info.get('sub', ''),
        'name': info.get('name', ''),
        'email': info.get('email', ''),
    }


def _exchange_linkedin(code, client_id, client_secret):
    r = requests.post(OAUTH_PROVIDERS['linkedin']['token_url'], data={
        'client_id': client_id,
        'client_secret': client_secret,
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': OAUTH_REDIRECT_URI,
    }, timeout=15)
    r.raise_for_status()
    token = r.json()['access_token']

    u = requests.get(OAUTH_PROVIDERS['linkedin']['userinfo_url'],
                     headers={'Authorization': f'Bearer {token}'}, timeout=10)
    u.raise_for_status()
    info = u.json()
    return {
        'id': info.get('sub', ''),
        'name': info.get('name', ''),
        'email': info.get('email', ''),
    }


def _exchange_twitter(code, client_id, client_secret, code_verifier=None):
    auth = (client_id, client_secret)
    data = {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': OAUTH_REDIRECT_URI,
    }
    if code_verifier:
        data['code_verifier'] = code_verifier

    r = requests.post(OAUTH_PROVIDERS['twitter']['token_url'],
                      data=data, auth=auth, timeout=15)
    r.raise_for_status()
    token = r.json()['access_token']

    u = requests.get(OAUTH_PROVIDERS['twitter']['userinfo_url'],
                     headers={'Authorization': f'Bearer {token}'}, timeout=10)
    u.raise_for_status()
    info = u.json().get('data', {})
    return {
        'id': info.get('id', ''),
        'name': info.get('name', ''),
        'email': '',
    }


def _exchange_apple(code, client_id):
    # Apple requires a JWT client_secret — built from team_id + key_id + p8 key.
    # For now, return minimal profile from the id_token.
    import jwt as pyjwt
    team_id = os.environ.get('APPLE_TEAM_ID', '')
    key_id = os.environ.get('APPLE_KEY_ID', '')
    key_path = os.environ.get('APPLE_PRIVATE_KEY_PATH', '')

    with open(key_path, 'r') as f:
        private_key = f.read()

    now = int(time.time())
    client_secret = pyjwt.encode(
        {'iss': team_id, 'iat': now, 'exp': now + 86400,
         'aud': 'https://appleid.apple.com', 'sub': client_id},
        private_key, algorithm='ES256',
        headers={'kid': key_id}
    )

    r = requests.post(OAUTH_PROVIDERS['apple']['token_url'], data={
        'client_id': client_id,
        'client_secret': client_secret,
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': OAUTH_REDIRECT_URI,
    }, timeout=15)
    r.raise_for_status()
    id_token = r.json().get('id_token', '')

    # Decode id_token (unverified — just to extract sub/email)
    payload = json.loads(
        base64.urlsafe_b64decode(id_token.split('.')[1] + '==')
    )
    return {
        'id': payload.get('sub', ''),
        'name': '',
        'email': payload.get('email', ''),
    }


EXCHANGE_FNS = {
    'orcid': _exchange_orcid,
    'google': _exchange_google,
    'linkedin': _exchange_linkedin,
    'twitter': _exchange_twitter,
    'apple': _exchange_apple,
}


# ===========================================================================
# CherryPy endpoint methods — paste inside the main API class in runweb.py
# ===========================================================================

# ---- 1. Start OAuth flow ----
@cherrypy.expose
@cherrypy.tools.json_out()
def api_biofs_researcher_oauth_start(self, provider=None, state=None):
    """GET /api_biofs_researcher_oauth_start?provider=orcid&state=<base64>
    Redirects the browser to the provider's OAuth consent screen.
    """
    if not provider or provider not in OAUTH_PROVIDERS:
        cherrypy.response.status = 400
        return {'error': f'Invalid provider. Must be one of: {list(OAUTH_PROVIDERS.keys())}'}

    cfg = OAUTH_PROVIDERS[provider]
    client_id = os.environ.get(cfg['client_id_env'], '')
    if not client_id:
        cherrypy.response.status = 500
        return {'error': f'{provider} OAuth not configured (missing {cfg["client_id_env"]})'}

    params = {
        'client_id': client_id,
        'redirect_uri': OAUTH_REDIRECT_URI,
        'response_type': 'code',
        'scope': cfg['scopes'],
        'state': _encode_state_with_provider(state, provider),
    }

    # Twitter requires PKCE
    if cfg.get('pkce'):
        code_verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode()
        code_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode()).digest()
        ).rstrip(b'=').decode()
        params['code_challenge'] = code_challenge
        params['code_challenge_method'] = 'S256'
        # Store verifier in a short-lived document so the callback can use it
        self.mongo_db['biofs_oauth_state'].insert_one({
            'state': state, 'code_verifier': code_verifier,
            'created_at': datetime.now(timezone.utc).isoformat()
        })

    # Apple needs response_mode=form_post
    if provider == 'apple':
        params['response_mode'] = 'form_post'

    auth_url = cfg['auth_url'] + '?' + '&'.join(
        f'{k}={requests.utils.quote(str(v))}' for k, v in params.items()
    )

    raise cherrypy.HTTPRedirect(auth_url)


# ---- 2. OAuth callback (provider redirects here) ----
@cherrypy.expose
def api_biofs_researcher_oauth_callback(self, code=None, state=None, error=None, **kwargs):
    """GET /api_biofs_researcher_oauth_callback?code=...&state=...
    Exchanges auth code for profile, creates custodial wallet,
    redirects to CLI callback or registration page.
    """
    # Decode state to get CLI returnUrl
    cli_return_url = None
    cli_session_id = None
    is_headless = False
    try:
        state_data = json.loads(base64.b64decode(state or ''))
        cli_return_url = state_data.get('returnUrl', '')
        cli_session_id = state_data.get('sessionId', '')
        is_headless = state_data.get('headless', False)
    except Exception:
        pass

    if error:
        return self._researcher_redirect_error(cli_return_url, error)

    if not code:
        return self._researcher_redirect_error(cli_return_url, 'No authorization code received')

    # Determine provider from state or referrer
    provider = kwargs.get('provider', '')
    if not provider:
        # Try to detect from the callback params
        for p in OAUTH_PROVIDERS:
            if os.environ.get(OAUTH_PROVIDERS[p]['client_id_env']):
                provider = p
                break

    # Actually — the provider is encoded in state too. Let me add it.
    # For now, try all configured providers. In practice, put provider in state.
    try:
        state_data_full = json.loads(base64.b64decode(state or ''))
        provider = state_data_full.get('provider', provider)
    except Exception:
        pass

    if not provider or provider not in EXCHANGE_FNS:
        return self._researcher_redirect_error(cli_return_url, 'Unknown provider')

    try:
        cfg = OAUTH_PROVIDERS[provider]
        client_id = os.environ.get(cfg['client_id_env'], '')
        client_secret = os.environ.get(cfg.get('client_secret_env', '') or '', '')

        # Twitter PKCE: retrieve code_verifier
        code_verifier = None
        if cfg.get('pkce') and state:
            st_doc = self.mongo_db['biofs_oauth_state'].find_one({'state': state})
            if st_doc:
                code_verifier = st_doc.get('code_verifier')
                self.mongo_db['biofs_oauth_state'].delete_one({'_id': st_doc['_id']})

        # Exchange code for profile
        exchange_fn = EXCHANGE_FNS[provider]
        if provider == 'twitter':
            profile = exchange_fn(code, client_id, client_secret, code_verifier)
        elif provider == 'apple':
            profile = exchange_fn(code, client_id)
        else:
            profile = exchange_fn(code, client_id, client_secret)

        # Get or create custodial wallet
        wallet, signature = _get_or_create_researcher_wallet(
            self.mongo_db, provider, profile['id'], profile
        )

        # Redirect back to CLI or to the registration page with credentials
        if cli_return_url:
            sep = '&' if '?' in cli_return_url else '?'
            redirect_url = (
                f'{cli_return_url}{sep}'
                f'wallet={requests.utils.quote(wallet)}'
                f'&signature={requests.utils.quote(signature)}'
                f'&fromAuth=true'
            )
            if cli_session_id:
                redirect_url += f'&sessionId={requests.utils.quote(cli_session_id)}'
            raise cherrypy.HTTPRedirect(redirect_url)
        else:
            # No CLI callback — redirect to registration page showing credentials
            redirect_url = (
                f'{RESEARCHER_REGISTER_PAGE}'
                f'?wallet={requests.utils.quote(wallet)}'
                f'&signature={requests.utils.quote(signature)}'
                f'&provider={provider}'
            )
            if is_headless:
                redirect_url += '&headless=true'
            raise cherrypy.HTTPRedirect(redirect_url)

    except cherrypy.HTTPRedirect:
        raise  # let redirects through
    except Exception as e:
        traceback.print_exc()
        return self._researcher_redirect_error(cli_return_url, str(e))


def _researcher_redirect_error(self, cli_return_url, error_msg):
    """Redirect back to registration page with error."""
    redirect_url = f'{RESEARCHER_REGISTER_PAGE}?oauth_error={requests.utils.quote(error_msg)}'
    raise cherrypy.HTTPRedirect(redirect_url)


# ---- 3. Researcher status (queried by CLI after registration) ----
@cherrypy.expose
@cherrypy.tools.json_out()
def api_biofs_researcher_status(self, wallet=None):
    """GET /api_biofs_researcher_status?wallet=0x...
    Returns the researcher's profile from biofs_researchers collection.
    """
    if not wallet:
        cherrypy.response.status = 400
        return {'error': 'wallet parameter required'}

    coll = self.mongo_db['biofs_researchers']
    doc = coll.find_one({'wallet_address': {'$regex': f'^{wallet}$', '$options': 'i'}})

    if not doc:
        cherrypy.response.status = 404
        return {'error': 'Researcher not found', 'wallet': wallet}

    return {
        'wallet_address': doc['wallet_address'],
        'provider': doc.get('provider', 'unknown'),
        'name': doc.get('name', ''),
        'email': doc.get('email', ''),
        'orcid_id': doc.get('orcid_id', ''),
        'institution': doc.get('institution', ''),
        'registered_at': doc.get('registered_at', ''),
        'last_login_at': doc.get('last_login_at', ''),
    }


# ---- 4. Register researcher (called by page after MetaMask auth) ----
@cherrypy.expose
@cherrypy.tools.json_in()
@cherrypy.tools.json_out()
def api_biofs_researcher_register(self):
    """POST /api_biofs_researcher_register
    Body: { wallet_address, provider, provider_id, name, email, orcid_id, institution }
    Upserts the researcher profile. No custodial wallet needed for MetaMask users.
    """
    data = cherrypy.request.json

    wallet = data.get('wallet_address', '').strip()
    if not wallet:
        cherrypy.response.status = 400
        return {'error': 'wallet_address required'}

    coll = self.mongo_db['biofs_researchers']

    now = datetime.now(timezone.utc).isoformat()

    update_fields = {
        'wallet_address': wallet,
        'provider': data.get('provider', 'metamask'),
        'provider_id': data.get('provider_id', wallet),
        'name': data.get('name', ''),
        'email': data.get('email', ''),
        'orcid_id': data.get('orcid_id', ''),
        'institution': data.get('institution', ''),
        'last_login_at': now,
    }

    result = coll.update_one(
        {'wallet_address': {'$regex': f'^{wallet}$', '$options': 'i'}},
        {
            '$set': update_fields,
            '$setOnInsert': {'registered_at': now}
        },
        upsert=True
    )

    return {
        'success': True,
        'wallet_address': wallet,
        'created': result.upserted_id is not None
    }


# ===========================================================================
# Add provider to OAuth state for detection in callback
# ===========================================================================
# IMPORTANT: Patch the oauth_start method to include 'provider' in the state:
#
# In api_biofs_researcher_oauth_start, replace:
#     'state': state or '',
# With:
#     'state': _encode_state_with_provider(state, provider),
#
# Where:
def _encode_state_with_provider(original_state, provider):
    """Inject provider name into the base64 state for callback detection."""
    try:
        data = json.loads(base64.b64decode(original_state or ''))
    except Exception:
        data = {}
    data['provider'] = provider
    return base64.b64encode(json.dumps(data).encode()).decode()
