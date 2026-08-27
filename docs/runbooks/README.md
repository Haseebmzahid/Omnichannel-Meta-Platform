# Runbooks

Status: Placeholder — populated in Implementation Roadmap Phase 16 (Production Readiness), once there is a
running system to write operational procedures for.

This directory will hold, at minimum:

- Token expiry / rotation failure response
- Webhook silence / delivery failure response (per channel)
- Gemini API outage or elevated error-rate response
- Appointment double-booking incident response
- False patient-identity merge incident response (see [ADR-004](../adr/ADR-004-patient-identity-model.md) §
  "failure asymmetry" — this is the highest-severity data-integrity incident class in the system)
- Deployment and rollback procedure
- On-call escalation path

Creating these now, before any of the systems they describe exist, would produce documentation disconnected from
real operational behaviour. They are written against the actual deployed system in Phase 16.
