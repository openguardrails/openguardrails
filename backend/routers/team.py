"""Team member management API - invitation, role management, member listing."""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, HTTPException, Request, Depends, status
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from typing import Optional, List
import secrets

from database.connection import get_admin_db
from database.models import Tenant, TenantMember, TenantInvitation
from config import settings
from utils.logger import setup_logger
from services.audit_log_service import log_operation, compute_changes

logger = setup_logger()

router = APIRouter(prefix="/api/v1/team", tags=["Team Management"])
public_router = APIRouter(prefix="/api/v1/team", tags=["Team Management (Public)"])


# --- Request/Response Models ---

class InviteMemberRequest(BaseModel):
    email: EmailStr
    role: str = "member"  # admin or member

class ChangeRoleRequest(BaseModel):
    role: str  # admin or member

class AcceptInvitationRequest(BaseModel):
    token: str
    password: Optional[str] = None  # Required if user doesn't have an account

class CreateMemberRequest(BaseModel):
    email: EmailStr
    password: str
    role: str = "member"  # admin or member

class MemberResponse(BaseModel):
    user_id: str
    email: str
    role: str
    joined_at: Optional[str] = None

class InvitationResponse(BaseModel):
    id: str
    email: str
    role: str
    status: str
    invited_by_email: Optional[str] = None
    expires_at: str
    created_at: str


# --- Helper Functions ---

def _get_auth_data(request: Request) -> dict:
    """Extract auth context data from request."""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context or 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return auth_context['data']


def _require_admin_role(auth_data: dict):
    """Require owner or admin role (or super admin)."""
    if auth_data.get('is_super_admin'):
        return
    role = auth_data.get('member_role', 'owner')
    if role not in ('owner', 'admin'):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _require_owner_role(auth_data: dict):
    """Require owner role (or super admin)."""
    if auth_data.get('is_super_admin'):
        return
    role = auth_data.get('member_role', 'owner')
    if role != 'owner':
        raise HTTPException(status_code=403, detail="Only the owner can perform this action")


# --- Endpoints ---

@router.get("/my-role")
async def get_my_role(request: Request, db: Session = Depends(get_admin_db)):
    """Get current user's role in their team."""
    auth_data = _get_auth_data(request)
    return {
        "member_role": auth_data.get('member_role', 'owner'),
        "tenant_id": auth_data.get('tenant_id'),
        "is_super_admin": auth_data.get('is_super_admin', False),
    }


@router.get("/members", response_model=List[MemberResponse])
async def list_members(request: Request, db: Session = Depends(get_admin_db)):
    """List all team members for the current tenant."""
    auth_data = _get_auth_data(request)
    tenant_id = auth_data['tenant_id']

    members = db.query(TenantMember, Tenant).join(
        Tenant, TenantMember.user_id == Tenant.id
    ).filter(
        TenantMember.tenant_id == tenant_id,
        TenantMember.invite_status == 'accepted',
        TenantMember.user_id.isnot(None),
    ).order_by(TenantMember.role, TenantMember.accepted_at).all()

    return [
        MemberResponse(
            user_id=str(member.user_id),
            email=tenant.email,
            role=member.role,
            joined_at=member.accepted_at.isoformat() if member.accepted_at else None,
        )
        for member, tenant in members
    ]


@router.post("/members")
async def create_member(
    member_data: CreateMemberRequest,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Directly create a team member (enterprise mode, owner/super_admin only).
    Bypasses email verification - the admin is responsible for user identity.
    """
    auth_data = _get_auth_data(request)
    _require_owner_role(auth_data)
    tenant_id = auth_data['tenant_id']

    if member_data.role not in ('admin', 'member'):
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'member'")

    # Check if email already exists
    existing_user = db.query(Tenant).filter(Tenant.email == member_data.email).first()
    if existing_user:
        # Check if already a member of this tenant
        existing_membership = db.query(TenantMember).filter(
            TenantMember.user_id == existing_user.id,
            TenantMember.tenant_id == tenant_id,
        ).first()
        if existing_membership:
            # Protect the owner - cannot modify owner via add user
            if existing_membership.role == 'owner':
                raise HTTPException(status_code=400, detail="Cannot modify the owner account")
            # User already a member - update password and role
            from utils.auth import get_password_hash
            old_role = existing_membership.role
            existing_user.password_hash = get_password_hash(member_data.password)
            existing_membership.role = member_data.role
            db.commit()
            logger.info(f"User {member_data.email} password/role updated by {auth_data.get('email')}")
            await log_operation(db, request, "update", "team_member", resource_id=str(existing_user.id), resource_name=member_data.email, changes={"role": {"old": old_role, "new": member_data.role}, "password": {"old": "***", "new": "***"}})
            return {"message": "User already exists, password and role updated", "user_id": str(existing_user.id)}

        # Check if user belongs to another organization
        other_membership = db.query(TenantMember).filter(
            TenantMember.user_id == existing_user.id,
        ).first()
        if other_membership:
            raise HTTPException(status_code=400, detail="User already belongs to another organization")

        # User exists but not in any team - re-add as member (e.g. previously removed)
        # Update password to the one provided by admin
        from utils.auth import get_password_hash
        existing_user.password_hash = get_password_hash(member_data.password)
        existing_user.is_active = True
        existing_user.is_verified = True

        inviter_user_id = auth_data.get('user_id') or auth_data.get('tenant_id')
        membership = TenantMember(
            tenant_id=tenant_id,
            user_id=existing_user.id,
            email=existing_user.email,
            role=member_data.role,
            invite_status='accepted',
            invited_by=inviter_user_id,
            accepted_at=datetime.now(timezone.utc),
        )
        db.add(membership)
        db.commit()

        logger.info(f"User {member_data.email} re-added by {auth_data.get('email')} with role {member_data.role}")
        await log_operation(db, request, "create", "team_member", resource_id=str(existing_user.id), resource_name=member_data.email)
        return {"message": "User added successfully", "user_id": str(existing_user.id)}

    # Validate password
    from utils.validators import validate_password_strength
    pw_validation = validate_password_strength(member_data.password)
    if not pw_validation["is_valid"]:
        raise HTTPException(
            status_code=400,
            detail=f"Password does not meet requirements: {', '.join(pw_validation['errors'])}"
        )

    # Create user account directly (skip email verification)
    from utils.auth import get_password_hash, generate_api_key
    user = Tenant(
        email=member_data.email,
        password_hash=get_password_hash(member_data.password),
        api_key=generate_api_key(),
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.flush()

    # Create membership
    inviter_user_id = auth_data.get('user_id') or auth_data.get('tenant_id')
    membership = TenantMember(
        tenant_id=tenant_id,
        user_id=user.id,
        email=user.email,
        role=member_data.role,
        invite_status='accepted',
        invited_by=inviter_user_id,
        accepted_at=datetime.now(timezone.utc),
    )
    db.add(membership)
    db.commit()

    logger.info(f"User {member_data.email} created directly by {auth_data.get('email')} with role {member_data.role}")
    await log_operation(db, request, "create", "team_member", resource_id=str(user.id), resource_name=member_data.email)
    return {"message": "User created successfully", "user_id": str(user.id)}


@router.post("/invitations")
async def send_invitation(
    invite_data: InviteMemberRequest,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Send a team invitation email."""
    auth_data = _get_auth_data(request)
    _require_admin_role(auth_data)
    tenant_id = auth_data['tenant_id']

    # Validate role
    if invite_data.role not in ('admin', 'member'):
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'member'")

    # Check if user is already a member of this tenant
    existing_user = db.query(Tenant).filter(Tenant.email == invite_data.email).first()
    if existing_user:
        existing_membership = db.query(TenantMember).filter(
            TenantMember.user_id == existing_user.id,
            TenantMember.tenant_id == tenant_id,
        ).first()
        if existing_membership:
            raise HTTPException(status_code=400, detail="User is already a member of this team")

        # Check if user is in another org
        other_membership = db.query(TenantMember).filter(
            TenantMember.user_id == existing_user.id,
        ).first()
        if other_membership and str(other_membership.tenant_id) != tenant_id:
            raise HTTPException(status_code=400, detail="User already belongs to another organization")

    # Check for existing pending invitation
    existing_invite = db.query(TenantInvitation).filter(
        TenantInvitation.tenant_id == tenant_id,
        TenantInvitation.email == invite_data.email,
        TenantInvitation.status == 'pending',
    ).first()
    if existing_invite:
        # Auto-expire if past expiration date
        if existing_invite.expires_at < datetime.now(timezone.utc):
            existing_invite.status = 'expired'
            db.commit()
        else:
            raise HTTPException(status_code=400, detail="A pending invitation already exists for this email")

    # Resolve inviter user_id
    inviter_user_id = auth_data.get('user_id') or auth_data.get('tenant_id')

    # Create invitation
    invitation_token = secrets.token_urlsafe(48)
    invitation = TenantInvitation(
        tenant_id=tenant_id,
        email=invite_data.email,
        role=invite_data.role,
        invited_by=inviter_user_id,
        invitation_token=invitation_token,
        status='pending',
        expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    )
    db.add(invitation)
    db.commit()

    # Send invitation email
    invitation_url = f"{settings.frontend_url}/platform/accept-invite?token={invitation_token}"
    try:
        from utils.email import send_team_invitation_email
        inviter_email = auth_data.get('email', '')
        send_team_invitation_email(
            email=invite_data.email,
            inviter_email=inviter_email,
            invitation_url=invitation_url,
            role=invite_data.role,
            language='en',
        )
    except Exception as e:
        logger.warning(f"Failed to send invitation email to {invite_data.email}: {e}")
        # Don't fail the invitation creation if email fails

    await log_operation(db, request, "create", "team_invitation", resource_id=str(invitation.id), resource_name=invite_data.email)
    return {"message": "Invitation sent successfully", "invitation_id": str(invitation.id)}


@router.get("/invitations", response_model=List[InvitationResponse])
async def list_invitations(request: Request, db: Session = Depends(get_admin_db)):
    """List pending invitations for the current tenant."""
    auth_data = _get_auth_data(request)
    _require_admin_role(auth_data)
    tenant_id = auth_data['tenant_id']

    invitations = db.query(TenantInvitation).filter(
        TenantInvitation.tenant_id == tenant_id,
        TenantInvitation.status == 'pending',
    ).order_by(TenantInvitation.created_at.desc()).all()

    # Expire old invitations
    now = datetime.now(timezone.utc)
    result = []
    for inv in invitations:
        if inv.expires_at < now:
            inv.status = 'expired'
            db.commit()
            continue
        # Look up inviter email
        inviter = db.query(Tenant).filter(Tenant.id == inv.invited_by).first()
        result.append(InvitationResponse(
            id=str(inv.id),
            email=inv.email,
            role=inv.role,
            status=inv.status,
            invited_by_email=inviter.email if inviter else None,
            expires_at=inv.expires_at.isoformat(),
            created_at=inv.created_at.isoformat(),
        ))

    return result


@router.delete("/invitations/{invitation_id}")
async def cancel_invitation(
    invitation_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Cancel a pending invitation."""
    auth_data = _get_auth_data(request)
    _require_admin_role(auth_data)
    tenant_id = auth_data['tenant_id']

    invitation = db.query(TenantInvitation).filter(
        TenantInvitation.id == invitation_id,
        TenantInvitation.tenant_id == tenant_id,
        TenantInvitation.status == 'pending',
    ).first()
    if not invitation:
        raise HTTPException(status_code=404, detail="Invitation not found")

    invitation_email = invitation.email
    invitation.status = 'cancelled'
    db.commit()
    await log_operation(db, request, "delete", "team_invitation", resource_id=str(invitation.id), resource_name=invitation_email)
    return {"message": "Invitation cancelled"}


@public_router.get("/invitations/verify/{token}")
async def verify_invitation(token: str, db: Session = Depends(get_admin_db)):
    """Verify an invitation token (public endpoint)."""
    invitation = db.query(TenantInvitation).filter(
        TenantInvitation.invitation_token == token,
        TenantInvitation.status == 'pending',
    ).first()

    if not invitation:
        raise HTTPException(status_code=404, detail="Invalid or expired invitation")

    if invitation.expires_at < datetime.now(timezone.utc):
        invitation.status = 'expired'
        db.commit()
        raise HTTPException(status_code=410, detail="Invitation has expired")

    # Check if user already has an account
    existing_user = db.query(Tenant).filter(Tenant.email == invitation.email).first()

    # Get org name (owner's email as org identifier)
    owner = db.query(Tenant).filter(Tenant.id == invitation.tenant_id).first()

    return {
        "email": invitation.email,
        "role": invitation.role,
        "org_email": owner.email if owner else None,
        "has_account": existing_user is not None,
        "is_verified": existing_user.is_verified if existing_user else False,
    }


@public_router.post("/invitations/accept")
async def accept_invitation(
    accept_data: AcceptInvitationRequest,
    db: Session = Depends(get_admin_db)
):
    """Accept a team invitation (public endpoint)."""
    invitation = db.query(TenantInvitation).filter(
        TenantInvitation.invitation_token == accept_data.token,
        TenantInvitation.status == 'pending',
    ).first()

    if not invitation:
        raise HTTPException(status_code=404, detail="Invalid or expired invitation")

    if invitation.expires_at < datetime.now(timezone.utc):
        invitation.status = 'expired'
        db.commit()
        raise HTTPException(status_code=410, detail="Invitation has expired")

    # Check if user already has an account
    user = db.query(Tenant).filter(Tenant.email == invitation.email).first()

    if user:
        # User exists - check they're not already in another org
        existing_membership = db.query(TenantMember).filter(TenantMember.user_id == user.id).first()
        if existing_membership and str(existing_membership.tenant_id) != str(invitation.tenant_id):
            raise HTTPException(
                status_code=400,
                detail="This email is already part of another organization. Please contact support."
            )
        if existing_membership and str(existing_membership.tenant_id) == str(invitation.tenant_id):
            # Already a member, just update the invitation
            invitation.status = 'accepted'
            invitation.accepted_at = datetime.now(timezone.utc)
            db.commit()
            return {"message": "You are already a member of this team"}
    else:
        # New user - create account (invitation serves as email verification)
        if not accept_data.password:
            raise HTTPException(status_code=400, detail="Password is required for new accounts")

        from utils.validators import validate_password_strength
        pw_validation = validate_password_strength(accept_data.password)
        if not pw_validation["is_valid"]:
            raise HTTPException(
                status_code=400,
                detail=f"Password does not meet requirements: {', '.join(pw_validation['errors'])}"
            )

        from utils.auth import get_password_hash, generate_api_key
        user = Tenant(
            email=invitation.email,
            password_hash=get_password_hash(accept_data.password),
            api_key=generate_api_key(),
            is_active=True,
            is_verified=True,  # Invitation serves as verification
        )
        db.add(user)
        db.flush()  # Get user.id

    # Create membership
    membership = TenantMember(
        tenant_id=invitation.tenant_id,
        user_id=user.id,
        email=user.email,
        role=invitation.role,
        invite_status='accepted',
        invited_by=invitation.invited_by,
        accepted_at=datetime.now(timezone.utc),
    )
    db.add(membership)

    # Mark invitation as accepted
    invitation.status = 'accepted'
    invitation.accepted_at = datetime.now(timezone.utc)
    db.commit()

    return {"message": "Invitation accepted successfully. You can now log in."}


@router.put("/members/{user_id}/role")
async def change_member_role(
    user_id: str,
    role_data: ChangeRoleRequest,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Change a team member's role. Only the owner can do this."""
    auth_data = _get_auth_data(request)
    _require_owner_role(auth_data)
    tenant_id = auth_data['tenant_id']

    if role_data.role not in ('admin', 'member'):
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'member'")

    membership = db.query(TenantMember).filter(
        TenantMember.tenant_id == tenant_id,
        TenantMember.user_id == user_id,
    ).first()

    if not membership:
        raise HTTPException(status_code=404, detail="Member not found")

    if membership.role == 'owner':
        raise HTTPException(status_code=400, detail="Cannot change the owner's role")

    old_role = membership.role
    membership.role = role_data.role
    membership.updated_at = datetime.now(timezone.utc)
    db.commit()

    # Look up member email for audit log
    member_user = db.query(Tenant).filter(Tenant.id == user_id).first()
    member_email = member_user.email if member_user else user_id
    await log_operation(db, request, "update", "team_member", resource_id=user_id, resource_name=member_email, changes={"role": {"old": old_role, "new": role_data.role}})

    # Invalidate auth cache for this user
    try:
        from utils.auth_cache import auth_cache
        auth_cache.clear()
    except Exception:
        pass

    return {"message": f"Role updated to {role_data.role}"}


@router.delete("/members/{user_id}")
async def remove_member(
    user_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Remove a team member. Owner and admin can do this."""
    auth_data = _get_auth_data(request)
    _require_admin_role(auth_data)
    tenant_id = auth_data['tenant_id']

    membership = db.query(TenantMember).filter(
        TenantMember.tenant_id == tenant_id,
        TenantMember.user_id == user_id,
    ).first()

    if not membership:
        raise HTTPException(status_code=404, detail="Member not found")

    if membership.role == 'owner':
        raise HTTPException(status_code=400, detail="Cannot remove the owner")

    # Admin cannot remove other admins (only owner can)
    if membership.role == 'admin' and auth_data.get('member_role') != 'owner' and not auth_data.get('is_super_admin'):
        raise HTTPException(status_code=403, detail="Only the owner can remove admins")

    member_email = membership.email or user_id
    db.delete(membership)
    db.commit()

    await log_operation(db, request, "delete", "team_member", resource_id=user_id, resource_name=member_email)

    # Invalidate auth cache
    try:
        from utils.auth_cache import auth_cache
        auth_cache.clear()
    except Exception:
        pass

    return {"message": "Member removed"}
