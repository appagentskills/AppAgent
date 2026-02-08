var TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "run_audit",
    description: "Run comprehensive ServiceNow instance audits. Can run all audits, specific categories, or individual checks. Returns findings organized by severity (critical, warning, info, passed).",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["all", "security", "users", "itsm", "system", "config"],
          description: "Audit category to run. Use 'all' for comprehensive audit."
        },
        checks: {
          type: "array",
          items: { type: "string" },
          description: "Specific check IDs to run (e.g., ['admin_accounts', 'breached_slas']). Overrides category if provided."
        },
        days_threshold: {
          type: "number",
          description: "Days threshold for stale record checks. Default: 30"
        }
      }
    }
  }
};

async function run_audit(args) {
  const category = args.category || "all";
  const specificChecks = args.checks || [];
  const daysThreshold = args.days_threshold || 30;

  const findings = {
    critical: [],
    warning: [],
    info: [],
    passed: [],
    metadata: {
      instance: "",
      audit_time: new Date().toISOString(),
      category: category,
      checks_run: []
    }
  };

  // Helper function to make API calls via executeTool
  async function query(table, options = {}) {
    try {
      const res = await executeTool("servicenow_api", {
        method: "GET",
        scope: "global",
        table: table,
        query: options.query,
        fields: options.fields,
        limit: options.limit || 50,
        url_params: options.display_value ? { sysparm_display_value: "true" } : undefined
      });
      return res.result || [];
    } catch (e) {
      console.error("Query failed:", e);
      return [];
    }
  }

  // Define all audit checks
  const auditChecks = {
    // SECURITY CHECKS
    admin_accounts: {
      category: "security",
      name: "Admin Accounts",
      run: async () => {
        const admins = await query("sys_user_has_role", {
          query: "role.name=admin^user.active=true",
          fields: "user.user_name,user.name,user.last_login",
          display_value: true,
          limit: 50
        });

        const neverLoggedIn = admins.filter(a => !a["user.last_login"]);
        const total = admins.length;

        if (neverLoggedIn.length > 5) {
          findings.critical.push({
            check: "admin_accounts",
            title: "Excessive Admin Accounts",
            count: total,
            detail: `${total} users have admin role, ${neverLoggedIn.length} have never logged in`,
            items: neverLoggedIn.slice(0, 10).map(a => a["user.user_name"]),
            recommendation: "Review and remove unnecessary admin access"
          });
        } else if (neverLoggedIn.length > 0) {
          findings.warning.push({
            check: "admin_accounts",
            title: "Admin Accounts Without Login",
            count: neverLoggedIn.length,
            detail: `${neverLoggedIn.length} admin users have never logged in`,
            items: neverLoggedIn.map(a => a["user.user_name"])
          });
        } else {
          findings.passed.push({
            check: "admin_accounts",
            title: "Admin Accounts",
            detail: `All ${total} admin users have logged in`
          });
        }
      }
    },

    locked_users: {
      category: "security",
      name: "Locked Out Users",
      run: async () => {
        const locked = await query("sys_user", {
          query: "active=true^locked_out=true",
          fields: "user_name,name,failed_attempts",
          limit: 50
        });

        if (locked.length > 0) {
          findings.warning.push({
            check: "locked_users",
            title: "Locked Out Active Users",
            count: locked.length,
            detail: `${locked.length} active users are locked out`,
            items: locked.map(u => u.user_name),
            recommendation: "Review if accounts should be unlocked or deactivated"
          });
        } else {
          findings.passed.push({
            check: "locked_users",
            title: "No Locked Out Users",
            detail: "No active users are currently locked out"
          });
        }
      }
    },

    client_callable_scripts: {
      category: "security",
      name: "Client-Callable Script Includes",
      run: async () => {
        const scripts = await query("sys_script_include", {
          query: "active=true^client_callable=true^access=public",
          fields: "name,api_name",
          limit: 50
        });

        if (scripts.length > 10) {
          findings.info.push({
            check: "client_callable_scripts",
            title: "Public Client-Callable Scripts",
            count: scripts.length,
            detail: `${scripts.length} public script includes are client-callable`,
            items: scripts.slice(0, 10).map(s => s.name),
            recommendation: "Review for security - ensure no sensitive operations exposed"
          });
        } else if (scripts.length > 0) {
          findings.info.push({
            check: "client_callable_scripts",
            title: "Client-Callable Scripts",
            count: scripts.length,
            detail: `${scripts.length} public script includes are client-callable`,
            items: scripts.map(s => s.name)
          });
        }
      }
    },

    open_acls: {
      category: "security",
      name: "ACLs Without Restrictions",
      run: async () => {
        const acls = await query("sys_security_acl", {
          query: "active=true^scriptISEMPTY^conditionISEMPTY^rolesISEMPTY",
          fields: "name,operation,type",
          display_value: true,
          limit: 50
        });

        if (acls.length > 20) {
          findings.warning.push({
            check: "open_acls",
            title: "ACLs Without Restrictions",
            count: acls.length,
            detail: `${acls.length} ACLs have no roles, conditions, or scripts`,
            items: acls.slice(0, 10).map(a => a.name),
            recommendation: "Review ACLs to ensure proper access control"
          });
        } else if (acls.length > 0) {
          findings.info.push({
            check: "open_acls",
            title: "Open ACLs",
            count: acls.length,
            detail: `${acls.length} ACLs have no restrictions (may be intentional)`
          });
        }
      }
    },

    security_properties: {
      category: "security",
      name: "Security Properties",
      run: async () => {
        const props = await query("sys_properties", {
          query: "nameINglide.security.diag_txns_acl,glide.authenticate.only.allow.active.user.login,glide.webauthn.enabled,glide.auth.mfa.ui.v2.enabled",
          fields: "name,value",
          limit: 10
        });

        const propMap = {};
        props.forEach(p => propMap[p.name] = p.value);

        const goodSettings = [];
        const badSettings = [];

        if (propMap["glide.security.diag_txns_acl"] === "true") {
          goodSettings.push("Diagnostic ACLs enabled");
        } else {
          badSettings.push("Diagnostic ACLs disabled");
        }

        if (propMap["glide.authenticate.only.allow.active.user.login"] === "true") {
          goodSettings.push("Only active users can login");
        } else {
          badSettings.push("Inactive users may be able to login");
        }

        if (propMap["glide.webauthn.enabled"] === "true") {
          goodSettings.push("WebAuthn (FIDO2) enabled");
        }

        if (propMap["glide.auth.mfa.ui.v2.enabled"] === "true") {
          goodSettings.push("MFA UI v2 enabled");
        }

        if (badSettings.length > 0) {
          findings.warning.push({
            check: "security_properties",
            title: "Security Property Issues",
            count: badSettings.length,
            detail: badSettings.join(", "),
            recommendation: "Review and enable recommended security settings"
          });
        }

        if (goodSettings.length > 0) {
          findings.passed.push({
            check: "security_properties",
            title: "Security Properties",
            detail: goodSettings.join(", ")
          });
        }
      }
    },

    // USER CHECKS
    groups_no_manager: {
      category: "users",
      name: "Groups Without Managers",
      run: async () => {
        const groups = await query("sys_user_group", {
          query: "active=true^managerISEMPTY",
          fields: "name",
          limit: 100
        });

        if (groups.length > 10) {
          findings.warning.push({
            check: "groups_no_manager",
            title: "Groups Without Managers",
            count: groups.length,
            detail: `${groups.length} active groups have no assigned manager`,
            items: groups.slice(0, 10).map(g => g.name),
            recommendation: "Assign managers for proper oversight and approvals"
          });
        } else if (groups.length > 0) {
          findings.info.push({
            check: "groups_no_manager",
            title: "Groups Without Managers",
            count: groups.length,
            detail: `${groups.length} groups have no manager`,
            items: groups.map(g => g.name)
          });
        } else {
          findings.passed.push({
            check: "groups_no_manager",
            title: "All Groups Have Managers",
            detail: "All active groups have assigned managers"
          });
        }
      }
    },

    // ITSM CHECKS
    stale_incidents: {
      category: "itsm",
      name: "Stale Incidents",
      run: async () => {
        const incidents = await query("incident", {
          query: `active=true^stateIN1,2,3^sys_updated_on<javascript:gs.daysAgoStart(${daysThreshold})`,
          fields: "number,short_description,state,priority,sys_updated_on,assigned_to",
          display_value: true,
          limit: 50
        });

        const critical = incidents.filter(i => i.priority && i.priority.includes("1"));

        if (incidents.length > 10 || critical.length > 0) {
          findings.critical.push({
            check: "stale_incidents",
            title: "Stale Incidents",
            count: incidents.length,
            detail: `${incidents.length} active incidents not updated in ${daysThreshold}+ days (${critical.length} critical)`,
            items: incidents.slice(0, 10).map(i => `${i.number}: ${i.short_description?.substring(0, 40)}`),
            recommendation: "Review and update or close stale incidents"
          });
        } else if (incidents.length > 0) {
          findings.warning.push({
            check: "stale_incidents",
            title: "Stale Incidents",
            count: incidents.length,
            detail: `${incidents.length} incidents not updated in ${daysThreshold}+ days`,
            items: incidents.map(i => i.number)
          });
        } else {
          findings.passed.push({
            check: "stale_incidents",
            title: "No Stale Incidents",
            detail: `All active incidents updated within ${daysThreshold} days`
          });
        }
      }
    },

    breached_slas: {
      category: "itsm",
      name: "Breached SLAs",
      run: async () => {
        const slas = await query("task_sla", {
          query: "has_breached=true^active=true",
          fields: "task,sla,stage,business_percentage",
          display_value: true,
          limit: 50
        });

        if (slas.length > 5) {
          findings.critical.push({
            check: "breached_slas",
            title: "Breached SLAs",
            count: slas.length,
            detail: `${slas.length} active SLAs are currently breached`,
            items: slas.slice(0, 10).map(s => `${s.task?.display_value || s.task}: ${s.sla?.display_value || s.sla}`),
            recommendation: "Address breached SLAs immediately to restore service levels"
          });
        } else if (slas.length > 0) {
          findings.warning.push({
            check: "breached_slas",
            title: "Breached SLAs",
            count: slas.length,
            detail: `${slas.length} SLAs are breached`,
            items: slas.map(s => s.task?.display_value || s.task)
          });
        } else {
          findings.passed.push({
            check: "breached_slas",
            title: "No Breached SLAs",
            detail: "No active SLAs are currently breached"
          });
        }
      }
    },

    pending_changes: {
      category: "itsm",
      name: "Pending Changes",
      run: async () => {
        const changes = await query("change_request", {
          query: "active=true^stateIN-5,-4,-3,-2,-1,0",
          fields: "number,short_description,state,risk,start_date,end_date",
          display_value: true,
          limit: 50
        });

        const highRisk = changes.filter(c => c.risk === "High");

        if (changes.length > 10 || highRisk.length > 2) {
          findings.warning.push({
            check: "pending_changes",
            title: "Pending Change Requests",
            count: changes.length,
            detail: `${changes.length} changes pending (${highRisk.length} high risk)`,
            items: changes.slice(0, 10).map(c => `${c.number}: ${c.short_description?.substring(0, 40)}`),
            recommendation: "Review pending changes and update statuses"
          });
        } else if (changes.length > 0) {
          findings.info.push({
            check: "pending_changes",
            title: "Pending Changes",
            count: changes.length,
            detail: `${changes.length} changes in pending states`
          });
        }
      }
    },

    active_problems: {
      category: "itsm",
      name: "Active Problems",
      run: async () => {
        const problems = await query("problem", {
          query: "active=true",
          fields: "number,short_description,state,priority,sys_updated_on",
          display_value: true,
          limit: 50
        });

        const critical = problems.filter(p => p.priority && p.priority.includes("1"));
        const high = problems.filter(p => p.priority && p.priority.includes("2"));

        if (critical.length > 0) {
          findings.critical.push({
            check: "active_problems",
            title: "Critical Problems",
            count: critical.length,
            detail: `${critical.length} critical problems are active`,
            items: critical.map(p => `${p.number}: ${p.short_description?.substring(0, 40)}`),
            recommendation: "Prioritize resolution of critical problems"
          });
        }

        if (problems.length > 10) {
          findings.warning.push({
            check: "active_problems",
            title: "Active Problems Backlog",
            count: problems.length,
            detail: `${problems.length} total active problems (${high.length} high priority)`,
            items: problems.slice(0, 5).map(p => p.number)
          });
        } else if (problems.length > 0) {
          findings.info.push({
            check: "active_problems",
            title: "Active Problems",
            count: problems.length,
            detail: `${problems.length} active problems`
          });
        }
      }
    },

    unassigned_critical: {
      category: "itsm",
      name: "Unassigned Critical Tickets",
      run: async () => {
        const incidents = await query("incident", {
          query: "active=true^priority=1^assigned_toISEMPTY",
          fields: "number,short_description,sys_created_on",
          limit: 20
        });

        if (incidents.length > 0) {
          findings.critical.push({
            check: "unassigned_critical",
            title: "Unassigned Critical Incidents",
            count: incidents.length,
            detail: `${incidents.length} critical incidents have no assignee`,
            items: incidents.map(i => i.number),
            recommendation: "Assign critical incidents immediately"
          });
        } else {
          findings.passed.push({
            check: "unassigned_critical",
            title: "Critical Incidents Assigned",
            detail: "All critical incidents have assignees"
          });
        }
      }
    },

    // SYSTEM CHECKS
    error_logs: {
      category: "system",
      name: "Error Logs",
      run: async () => {
        const errors = await query("syslog", {
          query: "level=0^sys_created_on>javascript:gs.daysAgoStart(7)",
          fields: "level,source,message,sys_created_on",
          limit: 20
        });

        const warnings = await query("syslog", {
          query: "level=1^sys_created_on>javascript:gs.daysAgoStart(7)",
          fields: "level,source,message",
          limit: 20
        });

        if (errors.length > 10) {
          findings.warning.push({
            check: "error_logs",
            title: "Recent Errors in Syslog",
            count: errors.length,
            detail: `${errors.length} errors in the last 7 days`,
            items: [...new Set(errors.slice(0, 5).map(e => e.source))],
            recommendation: "Review and address recurring errors"
          });
        } else if (errors.length > 0) {
          findings.info.push({
            check: "error_logs",
            title: "Syslog Errors",
            count: errors.length,
            detail: `${errors.length} errors, ${warnings.length} warnings in last 7 days`
          });
        } else {
          findings.passed.push({
            check: "error_logs",
            title: "No Recent Errors",
            detail: "No errors in syslog in the last 7 days"
          });
        }
      }
    },

    script_errors: {
      category: "system",
      name: "Script Errors",
      run: async () => {
        const errors = await query("syslog", {
          query: "source=Evaluator^levelIN0,1^sys_created_on>javascript:gs.daysAgoStart(7)",
          fields: "message,sys_created_on",
          limit: 30
        });

        // Find recurring errors
        const errorCounts = {};
        errors.forEach(e => {
          const key = e.message?.substring(0, 100) || "unknown";
          errorCounts[key] = (errorCounts[key] || 0) + 1;
        });

        const recurring = Object.entries(errorCounts).filter(([k, v]) => v > 2);

        if (recurring.length > 0) {
          findings.warning.push({
            check: "script_errors",
            title: "Recurring Script Errors",
            count: recurring.length,
            detail: `${recurring.length} recurring script errors detected`,
            items: recurring.slice(0, 5).map(([msg, count]) => `(${count}x) ${msg.substring(0, 60)}...`),
            recommendation: "Fix recurring script errors to improve stability"
          });
        } else if (errors.length > 0) {
          findings.info.push({
            check: "script_errors",
            title: "Script Errors",
            count: errors.length,
            detail: `${errors.length} script errors in last 7 days (no recurring patterns)`
          });
        }
      }
    },

    update_sets: {
      category: "system",
      name: "Update Sets",
      run: async () => {
        const updateSets = await query("sys_update_set", {
          query: "state=in progress^nameNOT LIKEDefault",
          fields: "name,sys_created_on,sys_created_by",
          limit: 20
        });

        if (updateSets.length > 5) {
          findings.warning.push({
            check: "update_sets",
            title: "Multiple Update Sets In Progress",
            count: updateSets.length,
            detail: `${updateSets.length} non-default update sets are in progress`,
            items: updateSets.map(u => u.name),
            recommendation: "Complete or abandon stale update sets"
          });
        } else if (updateSets.length > 0) {
          findings.info.push({
            check: "update_sets",
            title: "Update Sets In Progress",
            count: updateSets.length,
            detail: `${updateSets.length} update sets in progress`,
            items: updateSets.map(u => u.name)
          });
        } else {
          findings.passed.push({
            check: "update_sets",
            title: "Update Sets Clean",
            detail: "Only default update set is in progress"
          });
        }
      }
    },

    // CONFIG CHECKS
    non_operational_cis: {
      category: "config",
      name: "Non-Operational CIs",
      run: async () => {
        const cis = await query("cmdb_ci", {
          query: "operational_status=2",
          fields: "name,sys_class_name",
          display_value: true,
          limit: 30
        });

        if (cis.length > 0) {
          findings.info.push({
            check: "non_operational_cis",
            title: "Non-Operational Configuration Items",
            count: cis.length,
            detail: `${cis.length} CIs are marked as non-operational`,
            items: cis.slice(0, 10).map(c => `${c.name} (${c.sys_class_name})`),
            recommendation: "Review if these CIs should be retired or restored"
          });
        }
      }
    }
  };

  // Get instance name
  try {
    const instanceProps = await query("sys_properties", {
      query: "name=instance_name",
      fields: "value",
      limit: 1
    });
    findings.metadata.instance = instanceProps[0]?.value || "unknown";
  } catch (e) {
    findings.metadata.instance = "unknown";
  }

  // Determine which checks to run
  let checksToRun = [];

  if (specificChecks.length > 0) {
    checksToRun = specificChecks.filter(c => auditChecks[c]);
  } else if (category === "all") {
    checksToRun = Object.keys(auditChecks);
  } else {
    checksToRun = Object.keys(auditChecks).filter(k => auditChecks[k].category === category);
  }

  // Run the checks
  for (const checkId of checksToRun) {
    try {
      findings.metadata.checks_run.push(checkId);
      await auditChecks[checkId].run();
    } catch (error) {
      findings.warning.push({
        check: checkId,
        title: `Check Failed: ${checkId}`,
        detail: error.message || "Unknown error"
      });
    }
  }

  // Add summary
  findings.summary = {
    critical_count: findings.critical.length,
    warning_count: findings.warning.length,
    info_count: findings.info.length,
    passed_count: findings.passed.length,
    total_checks: checksToRun.length
  };

  return findings;
}
