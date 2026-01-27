"""
Model Route Service - Handles model routing logic for automatic upstream API selection
"""
from typing import Optional, List
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_, desc
import uuid

from database.models import ModelRoute, ModelRouteApplication, UpstreamApiConfig
from utils.logger import setup_logger

logger = setup_logger()


class ModelRouteService:
    """Service for model routing operations"""

    @staticmethod
    def find_matching_route(
        db: Session,
        tenant_id: str,
        model_name: str,
        application_id: Optional[str] = None
    ) -> Optional[UpstreamApiConfig]:
        """
        Find matching upstream API config based on model name and routing rules.

        Route matching priority:
        1. Application-specific routes (if application_id provided)
           - Sorted by: priority DESC, then exact match before prefix match
        2. Global routes (routes not bound to any application)
           - Sorted by: priority DESC, then exact match before prefix match

        Within each category:
        - Higher priority (larger number) routes are checked first
        - For same priority: exact match is preferred over prefix match
        - For same priority and match type: first match wins

        Args:
            db: Database session
            tenant_id: Tenant UUID string
            model_name: Model name from request (e.g., "gpt-4-turbo")
            application_id: Optional application UUID string

        Returns:
            UpstreamApiConfig if a matching route is found, None otherwise
        """
        try:
            tenant_uuid = uuid.UUID(tenant_id)

            # Get all active routes for this tenant, ordered by priority DESC
            routes_query = db.query(ModelRoute).filter(
                and_(
                    ModelRoute.tenant_id == tenant_uuid,
                    ModelRoute.is_active == True
                )
            ).order_by(
                desc(ModelRoute.priority)
            ).all()

            if not routes_query:
                logger.debug(f"No routes found for tenant {tenant_id}")
                return None

            # Separate routes into application-specific and global
            app_specific_routes: List[ModelRoute] = []
            global_routes: List[ModelRoute] = []

            for route in routes_query:
                # Check if this route has application bindings
                has_app_bindings = len(route.route_applications) > 0

                if has_app_bindings:
                    # Application-specific route - only add if it matches the application_id
                    if application_id:
                        app_uuid = uuid.UUID(application_id)
                        for binding in route.route_applications:
                            if binding.application_id == app_uuid:
                                app_specific_routes.append(route)
                                break
                else:
                    # Global route - applies to all applications
                    global_routes.append(route)

            # Helper function to check if a route matches the model name
            def route_matches(route: ModelRoute) -> bool:
                pattern = route.model_pattern.lower()
                model_lower = model_name.lower()

                if route.match_type == 'exact':
                    return model_lower == pattern
                else:  # prefix
                    return model_lower.startswith(pattern)

            # Helper function to find best match from a list of routes
            def find_best_match(routes: List[ModelRoute]) -> Optional[ModelRoute]:
                """Find the best matching route from a list, preferring exact match over prefix."""
                matching_routes = [r for r in routes if route_matches(r)]

                if not matching_routes:
                    return None

                # Sort by priority DESC, then by match_type (exact first)
                # Since routes are already sorted by priority DESC, we just need to prefer exact
                exact_matches = [r for r in matching_routes if r.match_type == 'exact']
                prefix_matches = [r for r in matching_routes if r.match_type == 'prefix']

                # Return the first exact match if any, otherwise first prefix match
                if exact_matches:
                    return exact_matches[0]
                elif prefix_matches:
                    return prefix_matches[0]
                return None

            # Try application-specific routes first
            if application_id and app_specific_routes:
                match = find_best_match(app_specific_routes)
                if match:
                    logger.info(f"Model routing: '{model_name}' matched app-specific route '{match.name}' (pattern: {match.model_pattern}, type: {match.match_type})")
                    return match.upstream_api_config

            # Then try global routes
            if global_routes:
                match = find_best_match(global_routes)
                if match:
                    logger.info(f"Model routing: '{model_name}' matched global route '{match.name}' (pattern: {match.model_pattern}, type: {match.match_type})")
                    return match.upstream_api_config

            logger.debug(f"Model routing: No matching route found for model '{model_name}'")
            return None

        except ValueError as e:
            logger.error(f"Invalid UUID format: {e}")
            return None
        except Exception as e:
            logger.error(f"Error finding matching route: {e}", exc_info=True)
            return None

    @staticmethod
    def get_routes_for_tenant(
        db: Session,
        tenant_id: str,
        include_inactive: bool = False
    ) -> List[ModelRoute]:
        """
        Get all routes for a tenant.

        Args:
            db: Database session
            tenant_id: Tenant UUID string
            include_inactive: Whether to include inactive routes

        Returns:
            List of ModelRoute objects
        """
        try:
            tenant_uuid = uuid.UUID(tenant_id)

            query = db.query(ModelRoute).filter(ModelRoute.tenant_id == tenant_uuid)

            if not include_inactive:
                query = query.filter(ModelRoute.is_active == True)

            return query.order_by(desc(ModelRoute.priority)).all()

        except ValueError as e:
            logger.error(f"Invalid UUID format: {e}")
            return []
        except Exception as e:
            logger.error(f"Error getting routes for tenant: {e}", exc_info=True)
            return []

    @staticmethod
    def create_route(
        db: Session,
        tenant_id: str,
        name: str,
        model_pattern: str,
        upstream_api_config_id: str,
        match_type: str = 'prefix',
        priority: int = 100,
        description: Optional[str] = None,
        application_ids: Optional[List[str]] = None
    ) -> Optional[ModelRoute]:
        """
        Create a new model route.

        Args:
            db: Database session
            tenant_id: Tenant UUID string
            name: Route name
            model_pattern: Model name pattern
            upstream_api_config_id: Upstream API config UUID string
            match_type: 'exact' or 'prefix'
            priority: Route priority (higher = more important)
            description: Optional description
            application_ids: Optional list of application UUIDs to bind this route to

        Returns:
            Created ModelRoute or None if failed
        """
        try:
            tenant_uuid = uuid.UUID(tenant_id)
            upstream_uuid = uuid.UUID(upstream_api_config_id)

            # Create the route
            route = ModelRoute(
                tenant_id=tenant_uuid,
                name=name,
                model_pattern=model_pattern,
                match_type=match_type,
                upstream_api_config_id=upstream_uuid,
                priority=priority,
                description=description,
                is_active=True
            )

            db.add(route)
            db.flush()  # Get the route ID

            # Add application bindings if provided
            if application_ids:
                for app_id in application_ids:
                    app_uuid = uuid.UUID(app_id)
                    binding = ModelRouteApplication(
                        model_route_id=route.id,
                        application_id=app_uuid
                    )
                    db.add(binding)

            db.commit()
            db.refresh(route)

            logger.info(f"Created model route: {route.name} ({route.model_pattern})")
            return route

        except Exception as e:
            db.rollback()
            logger.error(f"Error creating route: {e}", exc_info=True)
            return None

    @staticmethod
    def update_route(
        db: Session,
        route_id: str,
        tenant_id: str,
        updates: dict,
        application_ids: Optional[List[str]] = None
    ) -> Optional[ModelRoute]:
        """
        Update an existing model route.

        Args:
            db: Database session
            route_id: Route UUID string
            tenant_id: Tenant UUID string (for authorization)
            updates: Dictionary of fields to update
            application_ids: Optional list of application UUIDs (replaces existing bindings)

        Returns:
            Updated ModelRoute or None if failed
        """
        try:
            route_uuid = uuid.UUID(route_id)
            tenant_uuid = uuid.UUID(tenant_id)

            route = db.query(ModelRoute).filter(
                and_(
                    ModelRoute.id == route_uuid,
                    ModelRoute.tenant_id == tenant_uuid
                )
            ).first()

            if not route:
                logger.warning(f"Route not found: {route_id}")
                return None

            # Update fields
            for key, value in updates.items():
                if hasattr(route, key) and key not in ['id', 'tenant_id', 'created_at']:
                    setattr(route, key, value)

            # Update application bindings if provided
            if application_ids is not None:
                # Remove existing bindings
                db.query(ModelRouteApplication).filter(
                    ModelRouteApplication.model_route_id == route_uuid
                ).delete()

                # Add new bindings
                for app_id in application_ids:
                    app_uuid = uuid.UUID(app_id)
                    binding = ModelRouteApplication(
                        model_route_id=route.id,
                        application_id=app_uuid
                    )
                    db.add(binding)

            db.commit()
            db.refresh(route)

            logger.info(f"Updated model route: {route.name}")
            return route

        except Exception as e:
            db.rollback()
            logger.error(f"Error updating route: {e}", exc_info=True)
            return None

    @staticmethod
    def delete_route(
        db: Session,
        route_id: str,
        tenant_id: str
    ) -> bool:
        """
        Delete a model route.

        Args:
            db: Database session
            route_id: Route UUID string
            tenant_id: Tenant UUID string (for authorization)

        Returns:
            True if deleted, False otherwise
        """
        try:
            route_uuid = uuid.UUID(route_id)
            tenant_uuid = uuid.UUID(tenant_id)

            route = db.query(ModelRoute).filter(
                and_(
                    ModelRoute.id == route_uuid,
                    ModelRoute.tenant_id == tenant_uuid
                )
            ).first()

            if not route:
                logger.warning(f"Route not found: {route_id}")
                return False

            db.delete(route)
            db.commit()

            logger.info(f"Deleted model route: {route_id}")
            return True

        except Exception as e:
            db.rollback()
            logger.error(f"Error deleting route: {e}", exc_info=True)
            return False

    @staticmethod
    def get_route_by_id(
        db: Session,
        route_id: str,
        tenant_id: str
    ) -> Optional[ModelRoute]:
        """
        Get a route by ID.

        Args:
            db: Database session
            route_id: Route UUID string
            tenant_id: Tenant UUID string (for authorization)

        Returns:
            ModelRoute or None
        """
        try:
            route_uuid = uuid.UUID(route_id)
            tenant_uuid = uuid.UUID(tenant_id)

            return db.query(ModelRoute).filter(
                and_(
                    ModelRoute.id == route_uuid,
                    ModelRoute.tenant_id == tenant_uuid
                )
            ).first()

        except ValueError as e:
            logger.error(f"Invalid UUID format: {e}")
            return None
        except Exception as e:
            logger.error(f"Error getting route: {e}", exc_info=True)
            return None


# Singleton instance
model_route_service = ModelRouteService()
