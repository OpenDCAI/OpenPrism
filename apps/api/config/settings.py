"""Settings are 12-factor: everything comes from environment variables."""
import os
import re
import sys
from datetime import timedelta
from pathlib import Path
from urllib.parse import unquote, urlparse

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
# The app version has one source: apps/api/VERSION (the web build and Vite read the same file).
VERSION = (BASE_DIR / 'VERSION').read_text().strip()


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and value in (None, ''):
        raise ImproperlyConfigured(f'Missing required environment variable {name}')
    return value


def env_bool(name, default=False):
    return str(env(name, str(default))).lower() in ('1', 'true', 'yes', 'on')


DEBUG = env_bool('DJANGO_DEBUG', False)
TESTING = 'test' in sys.argv

# No insecure default: a deployment that forgets the secret must fail to start.
SECRET_KEY = env('DJANGO_SECRET_KEY', 'test-only-secret' if TESTING else None, required=True)
# Encrypts stored third-party credentials (Zotero). Comma-separated Fernet keys: the first encrypts, all decrypt,
# so a key is rotated by putting the new one in front. No default outside tests, like SECRET_KEY.
CREDENTIAL_ENCRYPTION_KEY = env('CREDENTIAL_ENCRYPTION_KEY',
                                'b3BlbnByaXNtLXRlc3Qta2V5LW5vdC1zZWNyZXQtMDE=' if TESTING else None, required=True)
ZOTERO_API_BASE = env('ZOTERO_API_BASE', 'https://api.zotero.org').rstrip('/')
if env_bool('DJANGO_BEHIND_TLS_PROXY', False):
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')  # the ingress terminates TLS

# Email (accounts/mail.py). Links in mails point at APP_BASE_URL, the origin people open the app at.
APP_BASE_URL = env('APP_BASE_URL', 'http://localhost:5173' if (DEBUG or TESTING) else None, required=True).rstrip('/')
EMAIL_BACKEND = ('django.core.mail.backends.locmem.EmailBackend' if TESTING
                 else env('EMAIL_BACKEND', 'django.core.mail.backends.smtp.EmailBackend'))
EMAIL_HOST = env('EMAIL_HOST', 'localhost')
EMAIL_PORT = int(env('EMAIL_PORT', '25'))
EMAIL_HOST_USER = env('EMAIL_HOST_USER', '')
EMAIL_HOST_PASSWORD = env('EMAIL_HOST_PASSWORD', '')
EMAIL_USE_TLS = env_bool('EMAIL_USE_TLS', False)
EMAIL_USE_SSL = env_bool('EMAIL_USE_SSL', False)
EMAIL_TIMEOUT = int(env('EMAIL_TIMEOUT', '20'))
# Accounts. REQUIRE_EMAIL_VERIFICATION: an unverified account may only reach the auth endpoints until it clicks the link.
# REGISTRATION_MODE: `invite` (the default: only addresses with a platform or workspace invitation) or `open` (anyone).
# The test runner defaults to `open`, since most tests register accounts freely; tests of the gate set the mode themselves.
REQUIRE_EMAIL_VERIFICATION = env_bool('REQUIRE_EMAIL_VERIFICATION', False)
REGISTRATION_MODE = env('REGISTRATION_MODE', 'open' if TESTING else 'invite')
if REGISTRATION_MODE not in ('open', 'invite'):
    raise ImproperlyConfigured('REGISTRATION_MODE must be "open" or "invite"')
# Platform invitations (v0.1.2): a superadmin's invitation to register lives this many days. WORKSPACE_INVITES_ALLOW_SIGNUP:
# in invite mode a workspace invitation also opens the door (off: platform invitations only). ACCESS_CONTACT_EMAIL is shown
# on the closed sign-up pages.
PLATFORM_INVITE_DAYS = int(env('PLATFORM_INVITE_DAYS', '7'))
if PLATFORM_INVITE_DAYS < 1:
    raise ImproperlyConfigured('PLATFORM_INVITE_DAYS must be at least 1')
WORKSPACE_INVITES_ALLOW_SIGNUP = env_bool('WORKSPACE_INVITES_ALLOW_SIGNUP', True)
ACCESS_CONTACT_EMAIL = env('ACCESS_CONTACT_EMAIL', '').strip()
if ACCESS_CONTACT_EMAIL and ('@' not in ACCESS_CONTACT_EMAIL or ' ' in ACCESS_CONTACT_EMAIL):
    raise ImproperlyConfigured('ACCESS_CONTACT_EMAIL must be an email address')
EMAIL_VERIFY_MAX_AGE = 3 * 24 * 3600  # seconds a verification link stays valid
PASSWORD_RESET_TIMEOUT = 3600  # seconds a reset link stays valid (it also dies when the password changes)
MAIL_SEND_INLINE = TESTING  # tests deliver to the locmem outbox at once instead of queueing a Celery task
DEFAULT_FROM_EMAIL = env('DEFAULT_FROM_EMAIL', 'OpenPrism <no-reply@localhost>')

ALLOWED_HOSTS = [h for h in env('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',') if h]

INSTALLED_APPS = [
    'accounts.adminconfig.SuperuserAdminConfig',  # django.contrib.admin with our site: superusers only (#80)
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',  # collectstatic for the admin (#79)
    'channels',
    'allauth',  # a library, not a UI: no allauth URLs, views or sessions (docs/spike-allauth.md)
    'allauth.account',
    'allauth.mfa',
    'rest_framework',
    'rest_framework_simplejwt.token_blacklist',
    'accounts',
    'projects',
    'templates_app',
    'jobs',
    'ai',
    'transfer',
    'collab',
    'integrations',
    'versions',
    'comments',
    'common',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',  # the admin's CSS/JS (#79); the API has no other static files
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'allauth.account.middleware.AccountMiddleware',  # sets allauth's request context; required by the app, adds no routes
]

ROOT_URLCONF = 'config.urls'
ASGI_APPLICATION = 'config.asgi.application'
WSGI_APPLICATION = None

TEMPLATES = [{
    'BACKEND': 'django.template.backends.django.DjangoTemplates',
    'DIRS': [],
    'APP_DIRS': True,
    'OPTIONS': {'context_processors': [
        'django.template.context_processors.request',
        'django.contrib.auth.context_processors.auth',
        'django.contrib.messages.context_processors.messages',
    ]},
}]


def _database():
    url = urlparse(env('DATABASE_URL', required=True))
    return {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': url.path.lstrip('/'),
        'USER': unquote(url.username or ''),
        'PASSWORD': unquote(url.password or ''),
        'HOST': url.hostname,
        'PORT': url.port or 5432,
        # Tests: close connections after every call so collab's worker-thread connections don't block DROP DATABASE.
        'CONN_MAX_AGE': 0 if TESTING else 60,
    }


DATABASES = {'default': _database()}

TEST_RUNNER = 'config.testrunner.Runner'
AUTH_USER_MODEL = 'accounts.User'
# django-allauth supplies the second factor (TOTP, recovery codes; passkeys and social sign-in later) as a library behind
# our own JWT endpoints. Its secrets are encrypted with CREDENTIAL_ENCRYPTION_KEY instead of stored in the clear.
ACCOUNT_USER_MODEL_USERNAME_FIELD = None
ACCOUNT_LOGIN_METHODS = {'email'}
ACCOUNT_SIGNUP_FIELDS = ['email*', 'password1*', 'password2*']
MFA_SUPPORTED_TYPES = ['totp', 'recovery_codes']
MFA_ADAPTER = 'accounts.mfa_adapter.FernetMFAAdapter'
MFA_TOTP_ISSUER = 'OpenPrism'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
]

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True
STATIC_URL = '/static/'
# `collectstatic` target, filled when the image is built (outside /app, which compose bind-mounts). WhiteNoise serves
# it; in debug and under tests it reads the apps' own files instead, so nothing has to be collected first.
STATIC_ROOT = env('STATIC_ROOT', '/app-static')
WHITENOISE_USE_FINDERS = DEBUG or TESTING

# Uploads up to 200 MB, as the Node backend allowed.
DATA_UPLOAD_MAX_MEMORY_SIZE = 200 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024
FILE_UPLOAD_HANDLERS = ['common.uploads.PathMemoryHandler', 'common.uploads.PathTemporaryHandler']

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'collab.auth.InviteAuthentication',  # `Bearer op2.…` invite tokens (project-scoped guests)
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': ['collab.auth.IsRealUser'],  # guests only reach views that opt in
    'DEFAULT_PARSER_CLASSES': [
        'rest_framework.parsers.JSONParser',
        'common.uploads.PathMultiPartParser',
    ],
    'DEFAULT_RENDERER_CLASSES': ['rest_framework.renderers.JSONRenderer'],
    'NUM_PROXIES': int(env('TRUSTED_PROXY_COUNT', '0')),  # reverse proxies in front of the API: rate limits key on the real client
    'DEFAULT_THROTTLE_CLASSES': ['rest_framework.throttling.ScopedRateThrottle'],  # only views that set throttle_scope
    'DEFAULT_THROTTLE_RATES': {
        'auth': env('AUTH_RATE_LIMIT', '10000/min' if TESTING else '20/min'),
        # every tab refreshes on load (the access token lives in memory only); a refresh needs a valid refresh token
        'refresh': env('AUTH_REFRESH_RATE_LIMIT', '10000/min' if TESTING else '120/min'),
    },
    'EXCEPTION_HANDLER': 'common.exceptions.ok_error_handler',
}

SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=int(env('JWT_ACCESS_MINUTES', '30'))),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=int(env('JWT_REFRESH_DAYS', '14'))),
    'AUTH_HEADER_TYPES': ('Bearer',),
    'ROTATE_REFRESH_TOKENS': True,       # each refresh issues a new refresh token…
    'BLACKLIST_AFTER_ROTATION': True,    # …and revokes the old one, so a stolen refresh token has a short life
    # Seconds of clock difference tolerated on `iat`/`exp`. 0 in production. The devcontainer's (WSL2) clock steps back
    # about a second several times a minute, so a token minted just before a step looked issued in the future and was
    # refused ("Token is invalid"); tests and the compose dev stack use 5.
    'LEEWAY': int(env('JWT_LEEWAY_SECONDS', '5' if TESTING else '0')),
}

# The refresh token lives in this httpOnly cookie (accounts/cookies.py); the access token only in the page's memory.
REFRESH_COOKIE_NAME = 'openprism_refresh'
# The Django admin (#80) is the only user of sessions and CSRF cookies: the app itself authenticates with JWTs. Its own
# cookie name and flags keep it apart from the app's cookies; the session is short.
ADMIN_SESSION_HOURS = int(env('ADMIN_SESSION_HOURS', '8'))
ADMIN_LOGIN_RATE_PER_15_MIN = int(env('ADMIN_LOGIN_RATE_PER_15_MIN', '10'))  # login form submissions per address
SESSION_COOKIE_NAME = 'openprism_admin'
SESSION_COOKIE_AGE = ADMIN_SESSION_HOURS * 3600
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Strict'
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SAMESITE = 'Strict'
REFRESH_COOKIE_SECURE = env_bool('REFRESH_COOKIE_SECURE', not DEBUG)  # browsers accept Secure cookies on http://localhost too
# Origins whose pages may use the refresh cookie (an Origin header must be one of these): APP_BASE_URL and any extra
# origins people open the app at (comma-separated), e.g. the nginx image on :8080 next to Vite on :5173 in dev.
TRUSTED_ORIGINS = sorted({APP_BASE_URL, *(o.strip().rstrip('/') for o in env('TRUSTED_ORIGINS', '').split(',') if o.strip())})
# The admin's login form is the one place Django checks CSRF; behind the proxies it must accept the app's origins.
CSRF_TRUSTED_ORIGINS = TRUSTED_ORIGINS
SESSION_COOKIE_SECURE = CSRF_COOKIE_SECURE = REFRESH_COOKIE_SECURE  # same rule as the refresh cookie

REDIS_URL = env('REDIS_URL', 'redis://localhost:6379/0')
if TESTING:  # tests share the dev Redis: keep their keys (and anything they enqueue) out of the dev database
    REDIS_URL = env('TEST_REDIS_URL', re.sub(r'/\d*$', '', REDIS_URL) + '/15')
# Shared across replicas so rate limits (login attempts) are enforced per user, not per process.
CACHES = {'default': {'BACKEND': 'django.core.cache.backends.redis.RedisCache', 'LOCATION': REDIS_URL}}
CELERY_BROKER_URL = env('CELERY_BROKER_URL', REDIS_URL)
CELERY_RESULT_BACKEND = env('CELERY_RESULT_BACKEND', REDIS_URL)
CELERY_TASK_ACKS_LATE = True  # a task whose worker dies is redelivered; tasks must tolerate re-running
CELERY_WORKER_PREFETCH_MULTIPLIER = 1  # long jobs: don't let one worker hoard queued tasks
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
CELERY_BROKER_TRANSPORT_OPTIONS = {'visibility_timeout': 900}  # must exceed the longest task time_limit
CELERY_TASK_ROUTES = {
    'jobs.tasks.compile_*': {'queue': 'compile'},
    'ai.tasks.*': {'queue': 'ai'},
    'transfer.tasks.*': {'queue': 'transfer'},  # served by worker-tex: transfer compiles LaTeX
    'projects.tasks.*': {'queue': 'import'},
    # Housekeeping from beat. No worker consumes Celery's default `celery` queue, so an unrouted task is never run:
    # without these, jobs whose worker died stay "running" forever and hold the user's compile slots (429).
    'jobs.tasks.reap_stale_jobs': {'queue': 'import'},
    'jobs.tasks.cleanup_old_jobs': {'queue': 'import'},
    'collab.tasks.*': {'queue': 'import'},
    'versions.tasks.*': {'queue': 'import'},
    'accounts.tasks.*': {'queue': 'import'},  # outgoing mail
    'integrations.tasks.*': {'queue': 'import'},
}
CELERY_BEAT_SCHEDULE = {
    'reap-stale-jobs': {'task': 'jobs.tasks.reap_stale_jobs', 'schedule': 60.0},
    'cleanup-old-jobs': {'task': 'jobs.tasks.cleanup_old_jobs', 'schedule': 3600.0},
    'cleanup-expired-invites': {'task': 'collab.tasks.cleanup_expired_invites', 'schedule': 3600.0},
    'recover-collab-logs': {'task': 'collab.tasks.recover_update_logs', 'schedule': 60.0},
    'prune-versions': {'task': 'versions.tasks.prune_versions', 'schedule': 86400.0},
    'prune-llm-usage': {'task': 'integrations.tasks.prune_llm_usage', 'schedule': 86400.0},
    'cleanup-pending-uploads': {'task': 'projects.tasks.cleanup_pending_uploads', 'schedule': 900.0},
}

LLM_TIMEOUT_SECONDS = int(env('LLM_TIMEOUT_SECONDS', '180'))
LLM_ALLOW_PRIVATE_ENDPOINTS = env_bool('LLM_ALLOW_PRIVATE_ENDPOINTS', False)  # true only for local models in dev
AI_WAIT_SECONDS = int(env('AI_WAIT_SECONDS', '300'))  # how long an AI endpoint blocks waiting for its worker
URL_TOKEN_SECONDS = int(env('URL_TOKEN_SECONDS', '3600'))  # lifetime of the scoped tokens in ?token= URLs
MAX_UPLOAD_BYTES = int(env('MAX_UPLOAD_BYTES', str(200 * 1024 * 1024)))  # one uploaded file
# Binary project files go from the browser straight to S3 (presigned PUT) instead of through the API. Needs
# S3_PUBLIC_ENDPOINT_URL reachable by browsers and bucket CORS for the app's origins (manage.py configure_s3_cors).
S3_DIRECT_UPLOADS = env_bool('S3_DIRECT_UPLOADS', False)
COLLAB_FLUSH_DEBOUNCE_MS = int(env('OPENPRISM_COLLAB_FLUSH_DEBOUNCE_MS', '800'))
COLLAB_INVITE_TTL_SECONDS = int(env('OPENPRISM_COLLAB_TOKEN_TTL', '86400'))
COLLAB_ROOM_EVICT_SECONDS = float(env('COLLAB_ROOM_EVICT_SECONDS', '60'))  # keep an idle room this long
COLLAB_SYNC_INTERVAL_SECONDS = float(env('COLLAB_SYNC_INTERVAL_SECONDS', '30'))  # anti-entropy merge with the DB
COLLAB_AWARENESS_TIMEOUT_SECONDS = float(env('COLLAB_AWARENESS_TIMEOUT_SECONDS', '30'))  # drop cursors not renewed (clients renew every 15 s)
JOB_SECRET_TTL_SECONDS = int(env('JOB_SECRET_TTL_SECONDS', str(6 * 3600)))  # how long a transfer job may keep its API key
MINERU_API_BASE = env('OPENPRISM_MINERU_API_BASE', 'https://mineru.net/api/v4')
MINERU_TOKEN = env('OPENPRISM_MINERU_TOKEN', '')
MINERU_POLL_INTERVAL_SECONDS = float(env('MINERU_POLL_INTERVAL_SECONDS', '3'))
MINERU_MAX_POLL_ATTEMPTS = int(env('MINERU_MAX_POLL_ATTEMPTS', '200'))
PLOT_TIMEOUT_SECONDS = int(env('PLOT_TIMEOUT_SECONDS', '60'))
TEX_CACHE_DIR = env('TEX_CACHE_DIR', '/tmp/openprism-tex-cache')  # font/format caches shared by compiles in one worker
# tectonic binary (bin/), offline package bundle (bundle/) and prebuilt format cache (cache/), from the worker-tex image
TECTONIC_HOME = env('TECTONIC_HOME', '/opt/tectonic')
COMPILE_TIMEOUT_SECONDS = int(env('COMPILE_TIMEOUT_SECONDS', '120'))  # per command (each pass / bibtex)
COMPILE_MAX_FILE_BYTES = int(env('COMPILE_MAX_FILE_BYTES', str(200 * 1024 * 1024)))
JOB_RUNNING_STALE_MINUTES = int(env('JOB_RUNNING_STALE_MINUTES', '10'))
JOB_QUEUED_STALE_MINUTES = int(env('JOB_QUEUED_STALE_MINUTES', '30'))
JOB_WAITING_STALE_MINUTES = int(env('JOB_WAITING_STALE_MINUTES', '60'))  # transfer left waiting for layout-check images
JOB_RETENTION_HOURS = int(env('JOB_RETENTION_HOURS', '24'))
AI_EDIT_RATE_PER_MINUTE = int(env('AI_EDIT_RATE_PER_MINUTE', '1000' if TESTING else '20'))  # in-place AI edit requests per user
# Per-user requests per minute on the expensive endpoints: AI jobs (llm, agent, vision, plot, transfer, arXiv import)
# and compiles (guests are counted per invite link).
AI_RATE_PER_MINUTE = int(env('AI_RATE_PER_MINUTE', '1000' if TESTING else '30'))
COMPILE_RATE_PER_MINUTE = int(env('COMPILE_RATE_PER_MINUTE', '1000' if TESTING else '30'))
# Who may run AI jobs on the operator's key (OPENPRISM_LLM_* on the workers), i.e. with no workspace, saved or
# browser key: all | verified (verified address) | staff | none. And how many such jobs per user per UTC day (0 = no limit).
SERVER_LLM_KEY_USERS = env('SERVER_LLM_KEY_USERS', 'all').strip().lower()
if SERVER_LLM_KEY_USERS not in ('all', 'verified', 'staff', 'none'):
    raise ImproperlyConfigured('SERVER_LLM_KEY_USERS must be all, verified, staff or none.')
SERVER_LLM_DAILY_QUOTA = int(env('SERVER_LLM_DAILY_QUOTA', '200'))
LLM_USAGE_KEEP_DAYS = int(env('LLM_USAGE_KEEP_DAYS', '400'))
VERSION_KEEP_UNNAMED = int(env('VERSION_KEEP_UNNAMED', '50'))  # unnamed versions kept per project; named ones are kept forever
VERSION_KEEP_FAILED = int(env('VERSION_KEEP_FAILED', '10'))  # unnamed failed-compile versions kept per project, counted apart

# The AWS_* names are what the deploy platform's object-storage Secret provides (boto3 / django-storages style).
S3_ENDPOINT_URL = env('S3_ENDPOINT_URL', env('AWS_ENDPOINT_URL_S3', env('AWS_S3_ENDPOINT_URL', 'http://localhost:3900')))
# URL embedded in presigned links; must be reachable by the browser, not just containers.
S3_PUBLIC_ENDPOINT_URL = env('S3_PUBLIC_ENDPOINT_URL', S3_ENDPOINT_URL)
S3_REGION = env('S3_REGION', 'garage')
S3_BUCKET = env('S3_BUCKET', 'openprism')
S3_ACCESS_KEY_ID = env('S3_ACCESS_KEY_ID', env('AWS_ACCESS_KEY_ID'), required=True)
S3_SECRET_ACCESS_KEY = env('S3_SECRET_ACCESS_KEY', env('AWS_SECRET_ACCESS_KEY'), required=True)

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'root': {'handlers': ['console'], 'level': env('LOG_LEVEL', 'INFO')},
}
