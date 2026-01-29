# Deployment OpenGuardrails plugin for Higress

## Service Sources
Create Servivce Sources
Type: Static Address
Name: openguardrails-local
Service Port: 80
Service Addresses: [your-og-ip-address]:5002
Service Protocal: http

## Plugin Management
Add a custom plugin 
Plugin Name: og-connector-higress
Plugin Description: OpenGuardrails Connector Plugin for Higress
Image URL: oci://docker.io/openguardrails/og-connector-higress:latest
Plugin Execution Phase: Default
Plugin Execution Priority: 993
Plugin Pull Policy: Default

## Plugin config
enable_input_detection: true
enable_output_detection: true
og_api_key: "[your-og-applicaion-id]"
og_base_url: "http://[your-og-ip-address]:5002"
og_cluster: "outbound|5002||openguardrails-local.static"
timeout_ms: 5000

and don't forget to enable the plugin.