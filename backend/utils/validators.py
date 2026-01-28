import re
from typing import List, Optional
from pydantic import BaseModel, validator
import httpx
from config import settings

class MessageValidator(BaseModel):
    """Message validator"""
    role: str
    content: str
    
    @validator('role')
    def validate_role(cls, v):
        if v not in ['user', 'system', 'assistant']:
            raise ValueError('role must be one of: user, system, assistant')
        return v
    
    @validator('content')
    def validate_content(cls, v):
        if not v or not v.strip():
            raise ValueError('content cannot be empty')
        if len(v) > 1000000:  # Limit content length
            raise ValueError('content too long (max 1000000 characters)')
        return v.strip()

def validate_api_key(api_key: str) -> bool:
    """Validate API key format"""
    if not api_key:
        return False
    
    # Must start with sk-xxai-, and the length is reasonable
    if not api_key.startswith('sk-xxai-'):
        return False
    if len(api_key) < 20 or len(api_key) > 128:
        return False
    
    return True

def validate_email(email: str) -> bool:
    """Validate email format"""
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, email))


# Personal email domains blacklist
PERSONAL_EMAIL_DOMAINS = {
    # Google
    'gmail.com', 'googlemail.com',
    # Microsoft
    'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
    # Yahoo
    'yahoo.com', 'yahoo.cn', 'yahoo.co.jp', 'yahoo.co.uk',
    # Apple
    'icloud.com', 'me.com', 'mac.com',
    # Chinese personal email providers
    'qq.com', 'foxmail.com',
    '163.com', '126.com', 'yeah.net',
    'sina.com', 'sina.cn',
    'sohu.com',
    'aliyun.com',
    '139.com',
    '189.cn',
    # Other common personal email providers
    'aol.com',
    'protonmail.com', 'proton.me',
    'zoho.com',
    'mail.com',
    'gmx.com', 'gmx.net',
    'yandex.com', 'yandex.ru',
    'mail.ru',
    'tutanota.com',
    'fastmail.com',
    # disposable email providers
    'protectsmail.net',
    'spamgourmet.com',
    'dropmeon.com',
    'feanzier.com',
    'awsl.uk',
    'yopmail.com',
    'mail.nuox.eu.org',
    'obeamb.com',
    'nespj.com',
    'hotmail.be',
    "1800banks.com",
    "3fdn.com",
    "93re.com",
    "a2qp.com",
    "abybuy.com",
    "adeany.com",
    "advitise.com",
    "affekopf.ch",
    "ailicke.com",
    "aituvip.com",
    "aixne.com",
    "aixnv.com",
    "akdip.com",
    "alisaol.com",
    "allrealfinanz.com",
    "almatips.com",
    "alosp.com",
    "alreval.com",
    "alysz.com",
    "amazon-center.shop",
    "american-tall.com",
    "amozix.com",
    "amzreports.online",
    "anarac.com",
    "anidaw.com",
    "aniross.com",
    "anypsd.com",
    "apostv.com",
    "aprte.com",
    "arcadein.com",
    "arktico.com",
    "artbycookie.com",
    "aubady.com",
    "auxille.com",
    "avtolev.com",
    "ayfoto.com",
    "azqas.com",
    "balawo.com",
    "barneu.com",
    "bettereve.com",
    "bhamweekly.com",
    "binech.com",
    "boftm.com",
    "boixi.com",
    "bountyptylimited.info",
    "boxnavi.com",
    "byagu.com",
    "cafesui.com",
    "caftee.com",
    "ceberium.com",
    "cengrop.com",
    "cevipsa.com",
    "chonxi.com",
    "ckqtlcsvqw.shop",
    "claudd.com",
    "claudecollection.shop",
    "cnanb.com",
    "cnieux.com",
    "cohdi.com",
    "coinxt.net",
    "comfortapotheek.com",
    "cosxo.com",
    "cpav3.com",
    "crowfiles.shop",
    "cutsup.com",
    "cxwet.com",
    "daddygo.site",
    "daikoa.com",
    "dbkmail.de",
    "dboso.com",
    "delorex.com",
    "devbike.com",
    "dhnow.com",
    "dietna.com",
    "docsign.site",
    "dotzq.com",
    "doulas.org",
    "dreamercast.shop",
    "dretnar.com",
    "dropcourse.net",
    "duclongshop.com",
    "dvdpit.com",
    "e052.com",
    "e-bazar.org",
    "ecstor.com",
    "educart.shop",
    "effexts.com",
    "eiveg.com",
    "elafans.com",
    "elerso.com",
    "encode-inc.com",
    "enmaila.com",
    "eosada.com",
    "eosatx.com",
    "eoslux.com",
    "ermael.com",
    "estebanmx.com",
    "euucn.com",
    "eveist.com",
    "exmab.com",
    "exuge.com",
    "eynlong.com",
    "fabtivia.com",
    "faxico.com",
    "fdigimail.web.id",
    "featcore.com",
    "feroxid.com",
    "fingso.com",
    "finloe.com",
    "fkainc.com",
    "flyrine.com",
    "fouraprilone.online",
    "fp-sys.com",
    "freans.com",
    "fuddydaddy.com",
    "funteka.com",
    "fxtubes.com",
    "ghostmailz.xyz",
    "godfare.com",
    "gonaute.com",
    "govfederal.ca",
    "h2beta.com",
    "haja.me",
    "handrik.com",
    "hatuhavote.icu",
    "hdala.com",
    "heixs.com",
    "hisila.com",
    "hkirsan.com",
    "horsesontour.com",
    "hotrod.top",
    "hpari.com",
    "hsfm.co.uk",
    "hunterscafe.com",
    "iconmal.com",
    "idawah.com",
    "ideuse.com",
    "ifoxdd.com",
    "ikewe.com",
    "imalias.com",
    "imnart.com",
    "inmail7.com",
    "inphuocthuy.vn",
    "inshuan.com",
    "internacionalmex.com",
    "intobx.com",
    "introex.com",
    "ioea.net",
    "iphonaticos.com.br",
    "iphonatics.shop",
    "iswire.com",
    "itaolo.com",
    "itcess.com",
    "ixhale.com",
    "japnc.com",
    "jetsay.com",
    "jincer.com",
    "jmvoice.com",
    "jokerstash.cc",
    "jqmails.com",
    "kaedar.com",
    "kenfern.com",
    "keokeg.com",
    "kerotu.com",
    "kidaroa.com",
    "klav6.com",
    "kodpan.com",
    "lashyd.com",
    "lawicon.com",
    "lerany.com",
    "lero3.com",
    "Liaphoto.com",
    "lifezg.com",
    "linkrer.com",
    "linlshe.com",
    "lizery.com",
    "lsaar.com",
    "luvethe.org",
    "lwide.com",
    "lyunsa.com",
    "macosten.com",
    "magos.dev",
    "mail-data.net",
    "mailfm.net",
    "mailsd.net",
    "mailvq.net",
    "mailvs.net",
    "makemoney15.com",
    "makemybiz.com",
    "maltabitcoinmining.com",
    "markoai.my.id",
    "mastermind911.com",
    "maxric.com",
    "maylx.com",
    "megacode.to",
    "menitao.com",
    "m.e-v.cc",
    "mexvat.com",
    "mitrajagoan.store",
    "miwacle.com",
    "mocvn.com",
    "mofpay.com",
    "msarra.com",
    "mustaer.com",
    "mxvia.com",
    "naprb.com",
    "natiret.com",
    "ncsar.com",
    "netfxd.com",
    "netinta.com",
    "ngem.net",
    "nhatu.com",
    "nicloo.com",
    "noihse.com",
    "notipr.com",
    "novatiz.com",
    "nsvpn.com",
    "nuclene.com",
    "numenor.cc",
    "oazv.net",
    "octbit.com",
    "ofirit.com",
    "okhko.com",
    "onepvp.com",
    "onionred.com",
    "onoranzefunebridegiovine.com",
    "ontasa.com",
    "onymi.com",
    "ordite.com",
    "oremal.com",
    "ostinmail.com",
    "outlookua.online",
    "ovbest.com",
    "oxbridgecertified.info",
    "oxtenda.com",
    "parclan.com",
    "pekoi.com",
    "phamay.com",
    "pox2.com",
    "professorpk.com",
    "prohade.com",
    "purfait.com",
    "qmailv.com",
    "racaho.com",
    "rambara.com",
    "ramcen.com",
    "ramizan.com",
    "rbesar.info",
    "reagantextile.com",
    "reeee.online",
    "rekaer.com",
    "renno.email",
    "revoadastore.shop",
    "rezato.com",
    "rhconseiltn.com",
    "rickix.com",
    "roalx.com",
    "rosebird.org",
    "roudar.com",
    "roweryo.com",
    "royalvx.com",
    "rwstatus.com",
    "saierw.com",
    "salave-transportes.com",
    "sanzv.com",
    "savests.com",
    "scatinc.com",
    "sdlat.com",
    "shaicn.com",
    "sheinup.com",
    "sicmg.com",
    "siiii.mywire.org",
    "sixze.com",
    "spotale.com",
    "steimports.shop",
    "steveix.com",
    "stoptheyap.com",
    "student.io.vn",
    "sunstones.biz",
    "supenc.com",
    "svmail.publicvm.com",
    "sweemri.com",
    "synarca.com",
    "syncax.com",
    "sztaoz.com",
    "taimb.com",
    "taugr.com",
    "tdekeg.online",
    "techtary.com",
    "tempmail.j78.org",
    "temp.meshari.dev",
    "tensico.com",
    "tenvil.com",
    "tgvis.com",
    "thenodish.org",
    "thesunand.com",
    "tirillo.com",
    "toolve.com",
    "torridy.com",
    "toymarques.shop",
    "travile.com",
    "trynta.com",
    "tunelux.com",
    "uaxpress.com",
    "udo8.com",
    "unite5.com",
    "vcois.com",
    "veb37.com",
    "venaten.com",
    "viv2.com",
    "vlemi.com",
    "vxsolar.com",
    "waivey.com",
    "webofip.com",
    "weekfly.com",
    "wifwise.com",
    "wikizs.com",
    "winocs.com",
    "wwc8.com",
    "wyla13.com",
    "xadoll.com",
    "xidealx.com",
    "xlcool.com",
    "xmage.live",
    "xmailtm.com",
    "xredb.com",
    "yakelu.com",
    "ymhis.com",
    "youtvbe.live",
    "yusolar.com",
    "zarhq.com",
    "zealian.com",
    "zetiv.store",
    "zizo7.com",
    "zosce.com",
    "hanhanmeow.top",
    "2925.com",
    "chacuo.net",
    "juhxs.com",
    "vip.sina.com"
}


def is_personal_email(email: str) -> bool:
    """
    Check if the email is from a personal email provider.

    Args:
        email: Email address to check

    Returns:
        True if it's a personal email, False if it's an enterprise email
    """
    if not email or '@' not in email:
        return True

    domain = email.lower().split('@')[-1]
    return domain in PERSONAL_EMAIL_DOMAINS


def check_disposable_email_via_api(domain: str) -> Optional[bool]:
    """
    Check if the domain is a disposable email using verifymail.io API.

    Args:
        domain: Email domain to check (e.g., "example.com")

    Returns:
        True if disposable, False if not disposable, None if API check fails or not configured
    """
    api_key = settings.verifymail_api_key
    if not api_key:
        # API key not configured, skip verification
        return None

    # Construct test email: tester@domain
    test_email = f"tester@{domain}"

    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.get(
                f"https://verifymail.io/api/{test_email}",
                params={"key": api_key}
            )
            response.raise_for_status()
            data = response.json()

            # Check block field - if true, it's a disposable email
            return data.get("block", False)

    except (httpx.HTTPError, KeyError, ValueError):
        # Log error but don't fail the registration
        # This allows registration to continue even if API fails
        return None


def is_disposable_email(email: str) -> bool:
    """
    Check if the email is from a disposable email provider.

    First checks against the PERSONAL_EMAIL_DOMAINS blacklist.
    If not found in blacklist and verifymail_api_key is configured,
    also queries the verifymail.io API for additional verification.

    Args:
        email: Email address to check

    Returns:
        True if it's a disposable email, False otherwise
    """
    if not email or '@' not in email:
        return True

    domain = email.lower().split('@')[-1]

    # First check against the static blacklist
    if domain in PERSONAL_EMAIL_DOMAINS:
        return True

    # Then check via verifymail.io API if configured
    # Use a cache to avoid repeated API calls for the same domain
    if hasattr(is_disposable_email, '_cache'):
        cache = is_disposable_email._cache
    else:
        cache = {}
        is_disposable_email._cache = cache

    if domain in cache:
        return cache[domain]

    result = check_disposable_email_via_api(domain)
    if result is None:
        # API check failed or not configured, assume not disposable
        # to avoid blocking legitimate registrations
        cache[domain] = False
        return False

    cache[domain] = result
    return result


def validate_enterprise_email(email: str) -> dict:
    """
    Validate that the email is from an enterprise domain.

    This performs multiple checks:
    1. Email format validation
    2. Personal email domain blacklist check
    3. Disposable email verification (via verifymail.io API if configured)

    Args:
        email: Email address to validate

    Returns:
        dict with keys:
        - is_valid: bool
        - error: error message if invalid
    """
    if not validate_email(email):
        return {
            "is_valid": False,
            "error": "Invalid email format"
        }

    if is_personal_email(email):
        return {
            "is_valid": False,
            "error": "Personal email addresses are not allowed. Please use your enterprise email."
        }

    # Additional disposable email check via API
    if is_disposable_email(email):
        domain = email.split('@')[-1]
        return {
            "is_valid": False,
            "error": f"Disposable email addresses are not allowed. The domain '{domain}' has been identified as a disposable email provider."
        }

    return {
        "is_valid": True,
        "error": None
    }

def sanitize_input(text: str) -> str:
    """Clean input text"""
    if not text:
        return ""
    
    # Remove potential malicious characters
    text = re.sub(r'[<>"\']', '', text)
    
    # Limit length
    if len(text) > 10000:
        text = text[:10000]
    
    return text.strip()

def clean_null_characters(text: str) -> str:
    """Clean NUL characters in the string, prevent database insertion error"""
    if not text:
        return text
    
    # Remove NUL characters (0x00) and other control characters
    # Keep common control characters like \n, \r, \t
    import re
    # Remove NUL characters
    text = text.replace('\x00', '')
    # Remove other control characters that may cause problems, but keep common ones like \n, \r, \t
    text = re.sub(r'[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    
    return text

def clean_detection_data(data: dict) -> dict:
    """Recursively clean NUL characters in detection data"""
    if isinstance(data, dict):
        return {key: clean_detection_data(value) for key, value in data.items()}
    elif isinstance(data, list):
        return [clean_detection_data(item) for item in data]
    elif isinstance(data, str):
        return clean_null_characters(data)
    else:
        return data

def extract_keywords(text: str) -> List[str]:
    """Extract keywords from text"""
    # Simple keyword extraction, can be optimized later
    words = re.findall(r'\w+', text.lower())
    return [word for word in words if len(word) > 2]

def validate_password_strength(password: str) -> dict:
    """
    Validate password strength

    Requirements:
    - At least 8 characters long
    - Contains uppercase letters
    - Contains lowercase letters
    - Contains numbers

    Returns:
        dict with keys:
        - is_valid: bool
        - errors: list of error messages
        - strength_score: int (0-100)
    """
    errors = []
    strength_score = 0

    # Length check
    if len(password) < 8:
        errors.append("Password must be at least 8 characters long")
    else:
        strength_score += 25

    # Uppercase check
    if not re.search(r'[A-Z]', password):
        errors.append("Password must contain at least one uppercase letter")
    else:
        strength_score += 25

    # Lowercase check
    if not re.search(r'[a-z]', password):
        errors.append("Password must contain at least one lowercase letter")
    else:
        strength_score += 25

    # Number check
    if not re.search(r'\d', password):
        errors.append("Password must contain at least one number")
    else:
        strength_score += 25

    # Bonus points for special characters
    if re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
        strength_score = min(100, strength_score + 10)

    # Bonus points for longer passwords
    if len(password) >= 12:
        strength_score = min(100, strength_score + 10)

    is_valid = len(errors) == 0

    return {
        "is_valid": is_valid,
        "errors": errors,
        "strength_score": strength_score
    }

def is_password_strong(password: str) -> bool:
    """Simple boolean check for password strength"""
    result = validate_password_strength(password)
    return result["is_valid"]