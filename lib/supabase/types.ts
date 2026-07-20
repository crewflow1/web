export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_name: string | null
          created_at: string
          id: string
          metadata: Json | null
          org_id: string
          target_id: string
          target_table: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          org_id: string
          target_id: string
          target_table: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          org_id?: string
          target_id?: string
          target_table?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_activity_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          created_at: string
          id: string
          metadata: Json | null
          target_id: string
          target_table: string
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id: string
          target_table: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id?: string
          target_table?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_activity_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_alert_state: {
        Row: {
          assigned_to: string | null
          created_at: string
          created_by: string | null
          id: string
          notified_at: string | null
          org_id: string
          read_at: string | null
          resolution_note: string | null
          resolved_at: string | null
          rule_id: string
          snoozed_until: string | null
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notified_at?: string | null
          org_id: string
          read_at?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          rule_id: string
          snoozed_until?: string | null
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notified_at?: string | null
          org_id?: string
          read_at?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          rule_id?: string
          snoozed_until?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_alert_state_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_alert_state_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_alert_state_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_employee_memory: {
        Row: {
          ai_employee_id: string
          content: string
          created_at: string
          id: string
          mem_key: string | null
          scope: string
          updated_at: string
        }
        Insert: {
          ai_employee_id: string
          content: string
          created_at?: string
          id?: string
          mem_key?: string | null
          scope?: string
          updated_at?: string
        }
        Update: {
          ai_employee_id?: string
          content?: string
          created_at?: string
          id?: string
          mem_key?: string | null
          scope?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_employee_memory_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_employee_tasks: {
        Row: {
          ai_employee_id: string
          completed_at: string | null
          created_at: string
          created_by_email: string | null
          created_by_id: string | null
          id: string
          metadata: Json | null
          status: string
          summary: string | null
          title: string
          updated_at: string
        }
        Insert: {
          ai_employee_id: string
          completed_at?: string | null
          created_at?: string
          created_by_email?: string | null
          created_by_id?: string | null
          id?: string
          metadata?: Json | null
          status?: string
          summary?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          ai_employee_id?: string
          completed_at?: string | null
          created_at?: string
          created_by_email?: string | null
          created_by_id?: string | null
          id?: string
          metadata?: Json | null
          status?: string
          summary?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_employee_tasks_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_employee_tasks_created_by_id_fkey"
            columns: ["created_by_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_employees: {
        Row: {
          accent: string
          created_at: string
          current_task: string | null
          department: string
          description: string
          icon: string
          id: string
          last_activity_at: string | null
          memory_scope: string
          model_name: string | null
          model_provider: string | null
          name: string
          role: string
          slug: string
          sort_order: number
          status: string
          system_prompt: string
          updated_at: string
        }
        Insert: {
          accent?: string
          created_at?: string
          current_task?: string | null
          department: string
          description?: string
          icon?: string
          id?: string
          last_activity_at?: string | null
          memory_scope?: string
          model_name?: string | null
          model_provider?: string | null
          name: string
          role: string
          slug: string
          sort_order?: number
          status?: string
          system_prompt?: string
          updated_at?: string
        }
        Update: {
          accent?: string
          created_at?: string
          current_task?: string | null
          department?: string
          description?: string
          icon?: string
          id?: string
          last_activity_at?: string | null
          memory_scope?: string
          model_name?: string | null
          model_provider?: string | null
          name?: string
          role?: string
          slug?: string
          sort_order?: number
          status?: string
          system_prompt?: string
          updated_at?: string
        }
        Relationships: []
      }
      ai_receptionist_setups: {
        Row: {
          business_hours: string | null
          business_phone: string | null
          configured_at: string | null
          configured_by: string | null
          created_at: string
          enabled: boolean
          facebook_page: string | null
          hq_notes: string | null
          id: string
          instagram_handle: string | null
          org_id: string
          preferred_voice: string | null
          status: string
          test_call_at: string | null
          test_lead_at: string | null
          test_meta_at: string | null
          test_sms_at: string | null
          test_voice_at: string | null
          test_whatsapp_at: string | null
          trade_type: string | null
          updated_at: string
          whatsapp_number: string | null
        }
        Insert: {
          business_hours?: string | null
          business_phone?: string | null
          configured_at?: string | null
          configured_by?: string | null
          created_at?: string
          enabled?: boolean
          facebook_page?: string | null
          hq_notes?: string | null
          id?: string
          instagram_handle?: string | null
          org_id: string
          preferred_voice?: string | null
          status?: string
          test_call_at?: string | null
          test_lead_at?: string | null
          test_meta_at?: string | null
          test_sms_at?: string | null
          test_voice_at?: string | null
          test_whatsapp_at?: string | null
          trade_type?: string | null
          updated_at?: string
          whatsapp_number?: string | null
        }
        Update: {
          business_hours?: string | null
          business_phone?: string | null
          configured_at?: string | null
          configured_by?: string | null
          created_at?: string
          enabled?: boolean
          facebook_page?: string | null
          hq_notes?: string | null
          id?: string
          instagram_handle?: string | null
          org_id?: string
          preferred_voice?: string | null
          status?: string
          test_call_at?: string | null
          test_lead_at?: string | null
          test_meta_at?: string | null
          test_sms_at?: string | null
          test_voice_at?: string | null
          test_whatsapp_at?: string | null
          trade_type?: string | null
          updated_at?: string
          whatsapp_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_receptionist_setups_configured_by_fkey"
            columns: ["configured_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_receptionist_setups_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_reply_audits: {
        Row: {
          allowed: boolean
          categories: string[]
          channel: string
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          draft: string
          employee_slug: string
          enquiry_id: string | null
          id: string
          lead_id: string | null
          metadata: Json
          org_id: string
          reason: string
          safe_text: string | null
          verdict: string
        }
        Insert: {
          allowed: boolean
          categories?: string[]
          channel: string
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          draft: string
          employee_slug: string
          enquiry_id?: string | null
          id?: string
          lead_id?: string | null
          metadata?: Json
          org_id: string
          reason: string
          safe_text?: string | null
          verdict: string
        }
        Update: {
          allowed?: boolean
          categories?: string[]
          channel?: string
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          draft?: string
          employee_slug?: string
          enquiry_id?: string | null
          id?: string
          lead_id?: string | null
          metadata?: Json
          org_id?: string
          reason?: string
          safe_text?: string | null
          verdict?: string
        }
        Relationships: []
      }
      ai_reply_delivery_receipts: {
        Row: {
          channel: string
          correlation_id: string
          created_at: string
          employee_slug: string
          error_code: string | null
          id: string
          metadata: Json
          org_id: string
          provider: string
          provider_message_id: string
          provider_status: string | null
          reply_audit_id: string
          status: string
          terminal: boolean
          transport_id: string
        }
        Insert: {
          channel: string
          correlation_id: string
          created_at?: string
          employee_slug: string
          error_code?: string | null
          id?: string
          metadata?: Json
          org_id: string
          provider: string
          provider_message_id: string
          provider_status?: string | null
          reply_audit_id: string
          status: string
          terminal?: boolean
          transport_id: string
        }
        Update: {
          channel?: string
          correlation_id?: string
          created_at?: string
          employee_slug?: string
          error_code?: string | null
          id?: string
          metadata?: Json
          org_id?: string
          provider?: string
          provider_message_id?: string
          provider_status?: string | null
          reply_audit_id?: string
          status?: string
          terminal?: boolean
          transport_id?: string
        }
        Relationships: []
      }
      ai_reply_transports: {
        Row: {
          attempt: number
          channel: string
          correlation_id: string
          cost_usd: number | null
          created_at: string
          dedup_key: string | null
          employee_slug: string
          failure_reason: string | null
          id: string
          latency_ms: number | null
          metadata: Json
          org_id: string
          provider: string | null
          provider_message_id: string | null
          reply_audit_id: string
          status: string
          to_ref: string
        }
        Insert: {
          attempt?: number
          channel: string
          correlation_id: string
          cost_usd?: number | null
          created_at?: string
          dedup_key?: string | null
          employee_slug: string
          failure_reason?: string | null
          id?: string
          latency_ms?: number | null
          metadata?: Json
          org_id: string
          provider?: string | null
          provider_message_id?: string | null
          reply_audit_id: string
          status: string
          to_ref: string
        }
        Update: {
          attempt?: number
          channel?: string
          correlation_id?: string
          cost_usd?: number | null
          created_at?: string
          dedup_key?: string | null
          employee_slug?: string
          failure_reason?: string | null
          id?: string
          latency_ms?: number | null
          metadata?: Json
          org_id?: string
          provider?: string | null
          provider_message_id?: string | null
          reply_audit_id?: string
          status?: string
          to_ref?: string
        }
        Relationships: []
      }
      asset_assignments: {
        Row: {
          actual_return_at: string | null
          asset_id: string
          assigned_at: string
          assigned_by: string | null
          assignee_id: string | null
          assignment_type: string
          created_at: string
          expected_return_at: string | null
          id: string
          issue_condition: string | null
          issue_meter_reading: number | null
          issue_notes: string | null
          job_id: string | null
          location: string | null
          org_id: string
          return_condition: string | null
          return_meter_reading: number | null
          return_notes: string | null
          returned_by: string | null
          status: string
          transferred_from_id: string | null
          updated_at: string
          vehicle_asset_id: string | null
        }
        Insert: {
          actual_return_at?: string | null
          asset_id: string
          assigned_at?: string
          assigned_by?: string | null
          assignee_id?: string | null
          assignment_type: string
          created_at?: string
          expected_return_at?: string | null
          id?: string
          issue_condition?: string | null
          issue_meter_reading?: number | null
          issue_notes?: string | null
          job_id?: string | null
          location?: string | null
          org_id: string
          return_condition?: string | null
          return_meter_reading?: number | null
          return_notes?: string | null
          returned_by?: string | null
          status?: string
          transferred_from_id?: string | null
          updated_at?: string
          vehicle_asset_id?: string | null
        }
        Update: {
          actual_return_at?: string | null
          asset_id?: string
          assigned_at?: string
          assigned_by?: string | null
          assignee_id?: string | null
          assignment_type?: string
          created_at?: string
          expected_return_at?: string | null
          id?: string
          issue_condition?: string | null
          issue_meter_reading?: number | null
          issue_notes?: string | null
          job_id?: string | null
          location?: string | null
          org_id?: string
          return_condition?: string | null
          return_meter_reading?: number | null
          return_notes?: string | null
          returned_by?: string | null
          status?: string
          transferred_from_id?: string | null
          updated_at?: string
          vehicle_asset_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_assignments_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_assignments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_assignments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_assignments_returned_by_fkey"
            columns: ["returned_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_assignments_transferred_from_id_fkey"
            columns: ["transferred_from_id"]
            isOneToOne: false
            referencedRelation: "asset_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_assignments_vehicle_asset_id_fkey"
            columns: ["vehicle_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_inspection_overrides: {
        Row: {
          asset_id: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          inspection_id: string
          org_id: string
          reason: string
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          updated_at: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          inspection_id: string
          org_id: string
          reason: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          updated_at?: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          inspection_id?: string
          org_id?: string
          reason?: string
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_inspection_overrides_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspection_overrides_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspection_overrides_inspection_id_fkey"
            columns: ["inspection_id"]
            isOneToOne: false
            referencedRelation: "asset_inspections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspection_overrides_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspection_overrides_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_inspection_schedules: {
        Row: {
          active: boolean
          asset_id: string
          created_at: string
          created_by: string | null
          id: string
          interval_days: number | null
          interval_months: number | null
          last_completed_at: string | null
          lead_time_days: number
          next_due: string
          org_id: string
          required_for_assignment: boolean
          template_id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          asset_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          interval_days?: number | null
          interval_months?: number | null
          last_completed_at?: string | null
          lead_time_days?: number
          next_due: string
          org_id: string
          required_for_assignment?: boolean
          template_id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          asset_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          interval_days?: number | null
          interval_months?: number | null
          last_completed_at?: string | null
          lead_time_days?: number
          next_due?: string
          org_id?: string
          required_for_assignment?: boolean
          template_id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_inspection_schedules_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspection_schedules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspection_schedules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspection_schedules_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "asset_inspection_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_inspection_templates: {
        Row: {
          categories: string[] | null
          check_level: string
          created_at: string
          created_by: string | null
          definition: Json
          description: string | null
          family_id: string
          id: string
          name: string
          org_id: string
          published_at: string | null
          published_by: string | null
          status: string
          supersedes_id: string | null
          updated_at: string
          version: number
        }
        Insert: {
          categories?: string[] | null
          check_level?: string
          created_at?: string
          created_by?: string | null
          definition?: Json
          description?: string | null
          family_id: string
          id?: string
          name: string
          org_id: string
          published_at?: string | null
          published_by?: string | null
          status?: string
          supersedes_id?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          categories?: string[] | null
          check_level?: string
          created_at?: string
          created_by?: string | null
          definition?: Json
          description?: string | null
          family_id?: string
          id?: string
          name?: string
          org_id?: string
          published_at?: string | null
          published_by?: string | null
          status?: string
          supersedes_id?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "asset_inspection_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspection_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspection_templates_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspection_templates_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "asset_inspection_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_inspections: {
        Row: {
          asset_id: string
          content: Json
          created_at: string
          created_by: string | null
          cycle_key: string | null
          due_at: string | null
          id: string
          inspected_at: string | null
          inspected_by: string | null
          kind: string | null
          org_id: string
          outcome: string | null
          reinspection_of: string | null
          revision: number
          safety_critical: boolean
          schedule_id: string | null
          snapshot: Json | null
          status: string
          supersedes_id: string | null
          template_id: string | null
          template_snapshot: Json | null
          template_version: number | null
          title: string
          updated_at: string
        }
        Insert: {
          asset_id: string
          content?: Json
          created_at?: string
          created_by?: string | null
          cycle_key?: string | null
          due_at?: string | null
          id?: string
          inspected_at?: string | null
          inspected_by?: string | null
          kind?: string | null
          org_id: string
          outcome?: string | null
          reinspection_of?: string | null
          revision?: number
          safety_critical?: boolean
          schedule_id?: string | null
          snapshot?: Json | null
          status?: string
          supersedes_id?: string | null
          template_id?: string | null
          template_snapshot?: Json | null
          template_version?: number | null
          title: string
          updated_at?: string
        }
        Update: {
          asset_id?: string
          content?: Json
          created_at?: string
          created_by?: string | null
          cycle_key?: string | null
          due_at?: string | null
          id?: string
          inspected_at?: string | null
          inspected_by?: string | null
          kind?: string | null
          org_id?: string
          outcome?: string | null
          reinspection_of?: string | null
          revision?: number
          safety_critical?: boolean
          schedule_id?: string | null
          snapshot?: Json | null
          status?: string
          supersedes_id?: string | null
          template_id?: string | null
          template_snapshot?: Json | null
          template_version?: number | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_inspections_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspections_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspections_inspected_by_fkey"
            columns: ["inspected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspections_reinspection_of_fkey"
            columns: ["reinspection_of"]
            isOneToOne: false
            referencedRelation: "asset_inspections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspections_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "asset_inspection_schedules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspections_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "asset_inspections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_inspections_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "asset_inspection_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_maintenance_case_costs: {
        Row: {
          case_id: string
          cost_external: number
          cost_labour: number
          cost_notes: string | null
          cost_parts: number
          created_at: string
          org_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          case_id: string
          cost_external?: number
          cost_labour?: number
          cost_notes?: string | null
          cost_parts?: number
          created_at?: string
          org_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          case_id?: string
          cost_external?: number
          cost_labour?: number
          cost_notes?: string | null
          cost_parts?: number
          created_at?: string
          org_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_maintenance_case_costs_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "asset_maintenance_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_case_costs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_case_costs_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_maintenance_cases: {
        Row: {
          asset_id: string
          assigned_to: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          case_type: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          cycle_key: string | null
          description: string | null
          downtime_end: string | null
          downtime_start: string | null
          id: string
          org_id: string
          out_of_service: boolean
          parts_used: string | null
          priority: string
          reinspection_required: boolean
          reported_by: string | null
          schedule_id: string | null
          scheduled_for: string | null
          source_assignment_id: string | null
          source_inspection_id: string | null
          status: string
          supplier_id: string | null
          title: string
          updated_at: string
          work_performed: string | null
        }
        Insert: {
          asset_id: string
          assigned_to?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          case_type: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          cycle_key?: string | null
          description?: string | null
          downtime_end?: string | null
          downtime_start?: string | null
          id?: string
          org_id: string
          out_of_service?: boolean
          parts_used?: string | null
          priority?: string
          reinspection_required?: boolean
          reported_by?: string | null
          schedule_id?: string | null
          scheduled_for?: string | null
          source_assignment_id?: string | null
          source_inspection_id?: string | null
          status?: string
          supplier_id?: string | null
          title: string
          updated_at?: string
          work_performed?: string | null
        }
        Update: {
          asset_id?: string
          assigned_to?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          case_type?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          cycle_key?: string | null
          description?: string | null
          downtime_end?: string | null
          downtime_start?: string | null
          id?: string
          org_id?: string
          out_of_service?: boolean
          parts_used?: string | null
          priority?: string
          reinspection_required?: boolean
          reported_by?: string | null
          schedule_id?: string | null
          scheduled_for?: string | null
          source_assignment_id?: string | null
          source_inspection_id?: string | null
          status?: string
          supplier_id?: string | null
          title?: string
          updated_at?: string
          work_performed?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_maintenance_cases_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_cases_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_cases_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_cases_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_cases_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_cases_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_cases_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "asset_service_schedules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_cases_source_assignment_id_fkey"
            columns: ["source_assignment_id"]
            isOneToOne: false
            referencedRelation: "asset_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_cases_source_inspection_id_fkey"
            columns: ["source_inspection_id"]
            isOneToOne: false
            referencedRelation: "asset_inspections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_cases_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_qr_identities: {
        Row: {
          active: boolean
          asset_id: string
          created_at: string
          generated_at: string
          generated_by: string | null
          id: string
          org_id: string
          regenerated_from: string | null
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          token: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          asset_id: string
          created_at?: string
          generated_at?: string
          generated_by?: string | null
          id?: string
          org_id: string
          regenerated_from?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          token: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          asset_id?: string
          created_at?: string
          generated_at?: string
          generated_by?: string | null
          id?: string
          org_id?: string
          regenerated_from?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_qr_identities_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_qr_identities_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_qr_identities_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_qr_identities_regenerated_from_fkey"
            columns: ["regenerated_from"]
            isOneToOne: false
            referencedRelation: "asset_qr_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_qr_identities_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_service_schedules: {
        Row: {
          active: boolean
          asset_id: string
          created_at: string
          created_by: string | null
          id: string
          interval_days: number | null
          interval_months: number | null
          last_completed_at: string | null
          lead_time_days: number
          maintenance_type: string
          next_due: string
          org_id: string
          supplier_id: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          asset_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          interval_days?: number | null
          interval_months?: number | null
          last_completed_at?: string | null
          lead_time_days?: number
          maintenance_type: string
          next_due: string
          org_id: string
          supplier_id?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          asset_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          interval_days?: number | null
          interval_months?: number | null
          last_completed_at?: string | null
          lead_time_days?: number
          maintenance_type?: string
          next_due?: string
          org_id?: string
          supplier_id?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_service_schedules_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_service_schedules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_service_schedules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_service_schedules_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          asset_ref: string | null
          category: string | null
          created_at: string
          created_by: string | null
          current_value: number | null
          hire_end: string | null
          hire_rate: number | null
          hire_start: string | null
          id: string
          manufacturer: string | null
          model: string | null
          name: string
          notes: string | null
          org_id: string
          ownership: string
          purchase_date: string | null
          purchase_price: number | null
          registration: string | null
          serial_number: string | null
          status: string
          supplier_id: string | null
          updated_at: string
          warranty_expires_at: string | null
        }
        Insert: {
          asset_ref?: string | null
          category?: string | null
          created_at?: string
          created_by?: string | null
          current_value?: number | null
          hire_end?: string | null
          hire_rate?: number | null
          hire_start?: string | null
          id?: string
          manufacturer?: string | null
          model?: string | null
          name: string
          notes?: string | null
          org_id: string
          ownership?: string
          purchase_date?: string | null
          purchase_price?: number | null
          registration?: string | null
          serial_number?: string | null
          status?: string
          supplier_id?: string | null
          updated_at?: string
          warranty_expires_at?: string | null
        }
        Update: {
          asset_ref?: string | null
          category?: string | null
          created_at?: string
          created_by?: string | null
          current_value?: number | null
          hire_end?: string | null
          hire_rate?: number | null
          hire_start?: string | null
          id?: string
          manufacturer?: string | null
          model?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          ownership?: string
          purchase_date?: string | null
          purchase_price?: number | null
          registration?: string | null
          serial_number?: string | null
          status?: string
          supplier_id?: string | null
          updated_at?: string
          warranty_expires_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_runs: {
        Row: {
          claimed_at: string | null
          completed_at: string | null
          correlation_id: string
          created_at: string
          duration_ms: number | null
          error_message: string | null
          event_type: string
          id: string
          org_id: string
          result: Json | null
          rule_id: string
          status: string
        }
        Insert: {
          claimed_at?: string | null
          completed_at?: string | null
          correlation_id: string
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          event_type: string
          id?: string
          org_id: string
          result?: Json | null
          rule_id: string
          status: string
        }
        Update: {
          claimed_at?: string | null
          completed_at?: string | null
          correlation_id?: string
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          event_type?: string
          id?: string
          org_id?: string
          result?: Json | null
          rule_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_statement_lines: {
        Row: {
          amount: number
          bank_statement_id: string
          created_at: string
          description: string | null
          id: string
          match_confidence: number | null
          match_status: string
          matched_invoice_id: string | null
          matched_payment_id: string | null
          org_id: string
          posted_at: string
          reference: string | null
        }
        Insert: {
          amount: number
          bank_statement_id: string
          created_at?: string
          description?: string | null
          id?: string
          match_confidence?: number | null
          match_status?: string
          matched_invoice_id?: string | null
          matched_payment_id?: string | null
          org_id: string
          posted_at: string
          reference?: string | null
        }
        Update: {
          amount?: number
          bank_statement_id?: string
          created_at?: string
          description?: string | null
          id?: string
          match_confidence?: number | null
          match_status?: string
          matched_invoice_id?: string | null
          matched_payment_id?: string | null
          org_id?: string
          posted_at?: string
          reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bank_statement_lines_bank_statement_id_fkey"
            columns: ["bank_statement_id"]
            isOneToOne: false
            referencedRelation: "bank_statements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_statement_lines_matched_invoice_id_fkey"
            columns: ["matched_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_statement_lines_matched_payment_id_fkey"
            columns: ["matched_payment_id"]
            isOneToOne: false
            referencedRelation: "invoice_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_statement_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_statements: {
        Row: {
          filename: string
          id: string
          line_count: number
          matched_count: number
          notes: string | null
          org_id: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          filename: string
          id?: string
          line_count?: number
          matched_count?: number
          notes?: string | null
          org_id: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          filename?: string
          id?: string
          line_count?: number
          matched_count?: number
          notes?: string | null
          org_id?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bank_statements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_statements_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_events: {
        Row: {
          claimed_at: string | null
          created_at: string
          error_message: string | null
          event_id: string | null
          event_type: string
          id: string
          org_id: string | null
          payload: Json
          processed_at: string | null
        }
        Insert: {
          claimed_at?: string | null
          created_at?: string
          error_message?: string | null
          event_id?: string | null
          event_type: string
          id?: string
          org_id?: string | null
          payload: Json
          processed_at?: string | null
        }
        Update: {
          claimed_at?: string | null
          created_at?: string
          error_message?: string | null
          event_id?: string | null
          event_type?: string
          id?: string
          org_id?: string | null
          payload?: Json
          processed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_invoices: {
        Row: {
          amount_gbp: number
          created_at: string
          created_by: string | null
          currency: string
          due_date: string | null
          failed_at: string | null
          failure_reason: string | null
          id: string
          kind: string
          notes: string | null
          org_id: string
          paid_at: string | null
          period_end: string | null
          period_start: string | null
          sent_at: string | null
          status: string
          stripe_invoice_id: string | null
          stripe_payment_intent_id: string | null
          updated_at: string
          voided_at: string | null
        }
        Insert: {
          amount_gbp: number
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string | null
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          kind: string
          notes?: string | null
          org_id: string
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          sent_at?: string | null
          status?: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
          voided_at?: string | null
        }
        Update: {
          amount_gbp?: number
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string | null
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          kind?: string
          notes?: string | null
          org_id?: string
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          sent_at?: string | null
          status?: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoices_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      calls: {
        Row: {
          ai_extracted: Json | null
          ai_summary: string | null
          caller_number: string | null
          conversation_id: string | null
          created_at: string
          direction: string
          duration_sec: number | null
          ended_at: string | null
          id: string
          lead_id: string | null
          org_id: string
          provider: string
          provider_call_id: string | null
          receiver_number: string | null
          recording_url: string | null
          started_at: string | null
          status: string
          transcript: string | null
          transcript_json: Json | null
        }
        Insert: {
          ai_extracted?: Json | null
          ai_summary?: string | null
          caller_number?: string | null
          conversation_id?: string | null
          created_at?: string
          direction: string
          duration_sec?: number | null
          ended_at?: string | null
          id?: string
          lead_id?: string | null
          org_id: string
          provider?: string
          provider_call_id?: string | null
          receiver_number?: string | null
          recording_url?: string | null
          started_at?: string | null
          status: string
          transcript?: string | null
          transcript_json?: Json | null
        }
        Update: {
          ai_extracted?: Json | null
          ai_summary?: string | null
          caller_number?: string | null
          conversation_id?: string | null
          created_at?: string
          direction?: string
          duration_sec?: number | null
          ended_at?: string | null
          id?: string
          lead_id?: string | null
          org_id?: string
          provider?: string
          provider_call_id?: string | null
          receiver_number?: string | null
          recording_url?: string | null
          started_at?: string | null
          status?: string
          transcript?: string | null
          transcript_json?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "calls_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_documents: {
        Row: {
          created_at: string
          expires_at: string | null
          filename: string | null
          id: string
          kind: string
          mime_type: string | null
          notes: string | null
          org_id: string
          reminded_30d_at: string | null
          reminded_7d_at: string | null
          reminded_today_at: string | null
          size_bytes: number | null
          storage_path: string
          title: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          filename?: string | null
          id?: string
          kind: string
          mime_type?: string | null
          notes?: string | null
          org_id: string
          reminded_30d_at?: string | null
          reminded_7d_at?: string | null
          reminded_today_at?: string | null
          size_bytes?: number | null
          storage_path: string
          title: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          filename?: string | null
          id?: string
          kind?: string
          mime_type?: string | null
          notes?: string | null
          org_id?: string
          reminded_30d_at?: string | null
          reminded_7d_at?: string | null
          reminded_today_at?: string | null
          size_bytes?: number | null
          storage_path?: string
          title?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compliance_documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          channel: string
          created_at: string
          customer_id: string | null
          external_id: string | null
          id: string
          last_message_at: string | null
          lead_id: string | null
          org_id: string
        }
        Insert: {
          channel: string
          created_at?: string
          customer_id?: string | null
          external_id?: string | null
          id?: string
          last_message_at?: string | null
          lead_id?: string | null
          org_id: string
        }
        Update: {
          channel?: string
          created_at?: string
          customer_id?: string | null
          external_id?: string | null
          id?: string
          last_message_at?: string | null
          lead_id?: string | null
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_runs: {
        Row: {
          completed_at: string | null
          duration_ms: number | null
          error_detail: string | null
          error_message: string | null
          id: string
          ok: boolean | null
          route: string
          started_at: string
          summary: Json | null
        }
        Insert: {
          completed_at?: string | null
          duration_ms?: number | null
          error_detail?: string | null
          error_message?: string | null
          id?: string
          ok?: boolean | null
          route: string
          started_at?: string
          summary?: Json | null
        }
        Update: {
          completed_at?: string | null
          duration_ms?: number | null
          error_detail?: string | null
          error_message?: string | null
          id?: string
          ok?: boolean | null
          route?: string
          started_at?: string
          summary?: Json | null
        }
        Relationships: []
      }
      customers: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          country: string
          county: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          org_id: string
          phone: string | null
          portal_token: string | null
          portal_token_expires_at: string | null
          portal_token_last_used_at: string | null
          postcode: string | null
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string
          county?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          org_id: string
          phone?: string | null
          portal_token?: string | null
          portal_token_expires_at?: string | null
          portal_token_last_used_at?: string | null
          postcode?: string | null
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string
          county?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          org_id?: string
          phone?: string | null
          portal_token?: string | null
          portal_token_expires_at?: string | null
          portal_token_last_used_at?: string | null
          postcode?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      dead_events: {
        Row: {
          attempts: number
          consumer: string
          created_at: string
          error: string
          event_id: number
          event_ts: string | null
          id: number
          payload: Json | null
          verb: string | null
        }
        Insert: {
          attempts?: number
          consumer: string
          created_at?: string
          error: string
          event_id: number
          event_ts?: string | null
          id?: never
          payload?: Json | null
          verb?: string | null
        }
        Update: {
          attempts?: number
          consumer?: string
          created_at?: string
          error?: string
          event_id?: number
          event_ts?: string | null
          id?: never
          payload?: Json | null
          verb?: string | null
        }
        Relationships: []
      }
      demo_requests: {
        Row: {
          approved_at: string | null
          company: string
          created_at: string
          current_systems: string | null
          email: string
          employees: string | null
          id: string
          internal_lead_id: string | null
          linked_org_id: string | null
          name: string
          notes: string | null
          notification_email_id: string | null
          notification_error: string | null
          notification_sent_at: string | null
          phone: string | null
          preferred_demo_time: string | null
          rejection_reason: string | null
          reviewed_by: string | null
          setup_fee_paid_at: string | null
          source: string | null
          status: string
          stripe_checkout_session_id: string | null
          stripe_checkout_url: string | null
          stripe_payment_status: string | null
          turnover_range: string | null
          user_agent: string | null
        }
        Insert: {
          approved_at?: string | null
          company: string
          created_at?: string
          current_systems?: string | null
          email: string
          employees?: string | null
          id?: string
          internal_lead_id?: string | null
          linked_org_id?: string | null
          name: string
          notes?: string | null
          notification_email_id?: string | null
          notification_error?: string | null
          notification_sent_at?: string | null
          phone?: string | null
          preferred_demo_time?: string | null
          rejection_reason?: string | null
          reviewed_by?: string | null
          setup_fee_paid_at?: string | null
          source?: string | null
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_checkout_url?: string | null
          stripe_payment_status?: string | null
          turnover_range?: string | null
          user_agent?: string | null
        }
        Update: {
          approved_at?: string | null
          company?: string
          created_at?: string
          current_systems?: string | null
          email?: string
          employees?: string | null
          id?: string
          internal_lead_id?: string | null
          linked_org_id?: string | null
          name?: string
          notes?: string | null
          notification_email_id?: string | null
          notification_error?: string | null
          notification_sent_at?: string | null
          phone?: string | null
          preferred_demo_time?: string | null
          rejection_reason?: string | null
          reviewed_by?: string | null
          setup_fee_paid_at?: string | null
          source?: string | null
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_checkout_url?: string | null
          stripe_payment_status?: string | null
          turnover_range?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "demo_requests_internal_lead_id_fkey"
            columns: ["internal_lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demo_requests_linked_org_id_fkey"
            columns: ["linked_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demo_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_drafts: {
        Row: {
          ai_confidence: number | null
          amount: number | null
          approved_at: string | null
          approved_by: string | null
          category: string | null
          created_at: string
          finance_id: string | null
          id: string
          invoice_date: string | null
          org_id: string
          reference: string | null
          rejected_at: string | null
          rejection_reason: string | null
          status: string
          supplier_id: string | null
          supplier_name: string | null
          total: number | null
          updated_at: string
          upload_id: string | null
          vat_rate: number | null
          vat_total: number | null
        }
        Insert: {
          ai_confidence?: number | null
          amount?: number | null
          approved_at?: string | null
          approved_by?: string | null
          category?: string | null
          created_at?: string
          finance_id?: string | null
          id?: string
          invoice_date?: string | null
          org_id: string
          reference?: string | null
          rejected_at?: string | null
          rejection_reason?: string | null
          status?: string
          supplier_id?: string | null
          supplier_name?: string | null
          total?: number | null
          updated_at?: string
          upload_id?: string | null
          vat_rate?: number | null
          vat_total?: number | null
        }
        Update: {
          ai_confidence?: number | null
          amount?: number | null
          approved_at?: string | null
          approved_by?: string | null
          category?: string | null
          created_at?: string
          finance_id?: string | null
          id?: string
          invoice_date?: string | null
          org_id?: string
          reference?: string | null
          rejected_at?: string | null
          rejection_reason?: string | null
          status?: string
          supplier_id?: string | null
          supplier_name?: string | null
          total?: number | null
          updated_at?: string
          upload_id?: string | null
          vat_rate?: number | null
          vat_total?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "expense_drafts_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_drafts_finance_id_fkey"
            columns: ["finance_id"]
            isOneToOne: false
            referencedRelation: "finances"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_drafts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_drafts_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      finances: {
        Row: {
          amount: number
          category: string | null
          created_at: string
          currency: string
          id: string
          job_id: string | null
          notes: string | null
          org_id: string
          receipt_url: string | null
          supplier_id: string | null
          updated_at: string
          vat_rate: number
          vat_total: number | null
        }
        Insert: {
          amount: number
          category?: string | null
          created_at?: string
          currency?: string
          id?: string
          job_id?: string | null
          notes?: string | null
          org_id: string
          receipt_url?: string | null
          supplier_id?: string | null
          updated_at?: string
          vat_rate?: number
          vat_total?: number | null
        }
        Update: {
          amount?: number
          category?: string | null
          created_at?: string
          currency?: string
          id?: string
          job_id?: string | null
          notes?: string | null
          org_id?: string
          receipt_url?: string | null
          supplier_id?: string | null
          updated_at?: string
          vat_rate?: number
          vat_total?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "finances_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finances_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finances_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      health_score_events: {
        Row: {
          created_at: string
          delta: number | null
          id: string
          new_score: number
          old_score: number | null
          org_id: string
          reasons: Json
          recomputed_at: string
          trigger: string
        }
        Insert: {
          created_at?: string
          delta?: number | null
          id?: string
          new_score: number
          old_score?: number | null
          org_id: string
          reasons?: Json
          recomputed_at?: string
          trigger: string
        }
        Update: {
          created_at?: string
          delta?: number | null
          id?: string
          new_score?: number
          old_score?: number | null
          org_id?: string
          reasons?: Json
          recomputed_at?: string
          trigger?: string
        }
        Relationships: [
          {
            foreignKeyName: "health_score_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_ai_executor_shadow_observations: {
        Row: {
          action_id: string
          correlation_id: string
          detail: string
          id: number
          idempotency_key: string | null
          kind: string
          observed_at: string
          outcome: string
          reason: string | null
          source: string
          task_id: string
          tool_label: string | null
        }
        Insert: {
          action_id: string
          correlation_id: string
          detail?: string
          id?: never
          idempotency_key?: string | null
          kind?: string
          observed_at?: string
          outcome: string
          reason?: string | null
          source: string
          task_id: string
          tool_label?: string | null
        }
        Update: {
          action_id?: string
          correlation_id?: string
          detail?: string
          id?: never
          idempotency_key?: string | null
          kind?: string
          observed_at?: string
          outcome?: string
          reason?: string | null
          source?: string
          task_id?: string
          tool_label?: string | null
        }
        Relationships: []
      }
      hq_ai_tasks: {
        Row: {
          approval_status: string | null
          assigned_employee_id: string | null
          claimed_at: string | null
          correlation_id: string
          cost_budget_micros: number | null
          cost_micros: number | null
          created_at: string
          created_by: string | null
          deadline_at: string | null
          dedupe_key: string | null
          depends_on: string[] | null
          error_message: string | null
          finished_at: string | null
          heartbeat_at: string | null
          id: string
          lease_expires_at: string | null
          lease_owner: string | null
          max_retries: number
          origin: string
          parent_task_id: string | null
          payload: Json
          priority: string
          priority_rank: number | null
          required_capability: string | null
          result: Json | null
          retry_count: number
          scheduled_at: string | null
          started_at: string | null
          status: string
          subject_id: string | null
          subject_kind: string
          task_type: string
          updated_at: string
          verification: Json | null
        }
        Insert: {
          approval_status?: string | null
          assigned_employee_id?: string | null
          claimed_at?: string | null
          correlation_id?: string
          cost_budget_micros?: number | null
          cost_micros?: number | null
          created_at?: string
          created_by?: string | null
          deadline_at?: string | null
          dedupe_key?: string | null
          depends_on?: string[] | null
          error_message?: string | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          lease_expires_at?: string | null
          lease_owner?: string | null
          max_retries?: number
          origin?: string
          parent_task_id?: string | null
          payload?: Json
          priority?: string
          priority_rank?: number | null
          required_capability?: string | null
          result?: Json | null
          retry_count?: number
          scheduled_at?: string | null
          started_at?: string | null
          status?: string
          subject_id?: string | null
          subject_kind?: string
          task_type: string
          updated_at?: string
          verification?: Json | null
        }
        Update: {
          approval_status?: string | null
          assigned_employee_id?: string | null
          claimed_at?: string | null
          correlation_id?: string
          cost_budget_micros?: number | null
          cost_micros?: number | null
          created_at?: string
          created_by?: string | null
          deadline_at?: string | null
          dedupe_key?: string | null
          depends_on?: string[] | null
          error_message?: string | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          lease_expires_at?: string | null
          lease_owner?: string | null
          max_retries?: number
          origin?: string
          parent_task_id?: string | null
          payload?: Json
          priority?: string
          priority_rank?: number | null
          required_capability?: string | null
          result?: Json | null
          retry_count?: number
          scheduled_at?: string | null
          started_at?: string | null
          status?: string
          subject_id?: string | null
          subject_kind?: string
          task_type?: string
          updated_at?: string
          verification?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "hq_ai_tasks_assigned_employee_id_fkey"
            columns: ["assigned_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_ai_tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "hq_ai_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_approvals: {
        Row: {
          action: string
          ai_employee_id: string
          correlation_id: string
          created_at: string
          decided_at: string | null
          decision_reason: string | null
          edited_payload: Json | null
          escalated_at: string | null
          expires_at: string | null
          id: string
          proposed_payload: Json
          requested_at: string
          reviewer_email: string | null
          reviewer_id: string | null
          state: string
          subject_id: string
          subject_type: string
          supersedes_id: string | null
          updated_at: string
        }
        Insert: {
          action: string
          ai_employee_id: string
          correlation_id?: string
          created_at?: string
          decided_at?: string | null
          decision_reason?: string | null
          edited_payload?: Json | null
          escalated_at?: string | null
          expires_at?: string | null
          id?: string
          proposed_payload?: Json
          requested_at?: string
          reviewer_email?: string | null
          reviewer_id?: string | null
          state?: string
          subject_id: string
          subject_type: string
          supersedes_id?: string | null
          updated_at?: string
        }
        Update: {
          action?: string
          ai_employee_id?: string
          correlation_id?: string
          created_at?: string
          decided_at?: string | null
          decision_reason?: string | null
          edited_payload?: Json | null
          escalated_at?: string | null
          expires_at?: string | null
          id?: string
          proposed_payload?: Json
          requested_at?: string
          reviewer_email?: string | null
          reviewer_id?: string | null
          state?: string
          subject_id?: string
          subject_type?: string
          supersedes_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_approvals_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_approvals_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_approvals_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "hq_approvals"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_backfill_state: {
        Row: {
          ceiling_created_at: string | null
          ceiling_id: string | null
          cursor_created_at: string
          cursor_id: string
          rows_emitted: number
          rows_seen: number
          rows_skipped: number
          source: string
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          ceiling_created_at?: string | null
          ceiling_id?: string | null
          cursor_created_at?: string
          cursor_id?: string
          rows_emitted?: number
          rows_seen?: number
          rows_skipped?: number
          source: string
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          ceiling_created_at?: string | null
          ceiling_id?: string | null
          cursor_created_at?: string
          cursor_id?: string
          rows_emitted?: number
          rows_seen?: number
          rows_skipped?: number
          source?: string
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      hq_capabilities: {
        Row: {
          created_at: string
          created_by_email: string | null
          created_by_id: string | null
          description: string
          id: string
          kind: string
          token: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_email?: string | null
          created_by_id?: string | null
          description?: string
          id?: string
          kind?: string
          token: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_email?: string | null
          created_by_id?: string | null
          description?: string
          id?: string
          kind?: string
          token?: string
          updated_at?: string
        }
        Relationships: []
      }
      hq_capability_grants: {
        Row: {
          budget_default: number | null
          can_execute: boolean
          created_at: string
          created_by_email: string | null
          created_by_id: string | null
          id: string
          memory_scope: string
          registration: Json
          requires_approval: boolean
          scope_key: string | null
          scope_level: string
          tokens: string[]
          updated_at: string
        }
        Insert: {
          budget_default?: number | null
          can_execute?: boolean
          created_at?: string
          created_by_email?: string | null
          created_by_id?: string | null
          id?: string
          memory_scope?: string
          registration?: Json
          requires_approval?: boolean
          scope_key?: string | null
          scope_level: string
          tokens?: string[]
          updated_at?: string
        }
        Update: {
          budget_default?: number | null
          can_execute?: boolean
          created_at?: string
          created_by_email?: string | null
          created_by_id?: string | null
          id?: string
          memory_scope?: string
          registration?: Json
          requires_approval?: boolean
          scope_key?: string | null
          scope_level?: string
          tokens?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      hq_comms_suppressions: {
        Row: {
          address: string
          channel: string
          created_at: string
          id: string
          note: string | null
          reason: string
          source_communication_id: string | null
        }
        Insert: {
          address: string
          channel?: string
          created_at?: string
          id?: string
          note?: string | null
          reason: string
          source_communication_id?: string | null
        }
        Update: {
          address?: string
          channel?: string
          created_at?: string
          id?: string
          note?: string | null
          reason?: string
          source_communication_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hq_comms_suppressions_source_communication_id_fkey"
            columns: ["source_communication_id"]
            isOneToOne: false
            referencedRelation: "hq_communications"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_communications: {
        Row: {
          ai_employee_id: string
          approval_id: string
          attempt: number
          channel: string
          correlation_id: string
          cost_usd: number | null
          created_at: string
          draft_id: string
          failure_reason: string | null
          id: string
          latency_ms: number | null
          provider: string
          provider_message_id: string | null
          sent_at: string | null
          settled_at: string | null
          status: string
          subject_id: string
          subject_type: string
          supersedes_id: string | null
          to_address: string
          updated_at: string
        }
        Insert: {
          ai_employee_id: string
          approval_id: string
          attempt?: number
          channel?: string
          correlation_id?: string
          cost_usd?: number | null
          created_at?: string
          draft_id: string
          failure_reason?: string | null
          id?: string
          latency_ms?: number | null
          provider: string
          provider_message_id?: string | null
          sent_at?: string | null
          settled_at?: string | null
          status: string
          subject_id: string
          subject_type: string
          supersedes_id?: string | null
          to_address: string
          updated_at?: string
        }
        Update: {
          ai_employee_id?: string
          approval_id?: string
          attempt?: number
          channel?: string
          correlation_id?: string
          cost_usd?: number | null
          created_at?: string
          draft_id?: string
          failure_reason?: string | null
          id?: string
          latency_ms?: number | null
          provider?: string
          provider_message_id?: string | null
          sent_at?: string | null
          settled_at?: string | null
          status?: string
          subject_id?: string
          subject_type?: string
          supersedes_id?: string | null
          to_address?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_communications_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_communications_approval_id_fkey"
            columns: ["approval_id"]
            isOneToOne: false
            referencedRelation: "hq_approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_communications_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "hq_drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_communications_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "hq_communications"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_consumer_retries: {
        Row: {
          attempts: number
          consumer: string
          event_id: number
          first_failed_at: string
          last_error: string | null
          last_failed_at: string
        }
        Insert: {
          attempts?: number
          consumer: string
          event_id: number
          first_failed_at?: string
          last_error?: string | null
          last_failed_at?: string
        }
        Update: {
          attempts?: number
          consumer?: string
          event_id?: number
          first_failed_at?: string
          last_error?: string | null
          last_failed_at?: string
        }
        Relationships: []
      }
      hq_consumer_selftest: {
        Row: {
          applied_at: string
          consumer: string
          event_id: number
          verb: string
        }
        Insert: {
          applied_at?: string
          consumer: string
          event_id: number
          verb: string
        }
        Update: {
          applied_at?: string
          consumer?: string
          event_id?: number
          verb?: string
        }
        Relationships: []
      }
      hq_drafts: {
        Row: {
          ai_employee_id: string
          content: Json
          correlation_id: string
          cost_usd: number | null
          created_at: string
          fallback_reason: string | null
          id: string
          input_tokens: number
          kind: string
          latency_ms: number | null
          model: string | null
          output_tokens: number
          prompt_checksum: string
          prompt_version: string
          provenance: string
          status: string
          subject_id: string
          subject_type: string
          supersedes_id: string | null
        }
        Insert: {
          ai_employee_id: string
          content?: Json
          correlation_id?: string
          cost_usd?: number | null
          created_at?: string
          fallback_reason?: string | null
          id?: string
          input_tokens?: number
          kind: string
          latency_ms?: number | null
          model?: string | null
          output_tokens?: number
          prompt_checksum: string
          prompt_version: string
          provenance: string
          status: string
          subject_id: string
          subject_type: string
          supersedes_id?: string | null
        }
        Update: {
          ai_employee_id?: string
          content?: Json
          correlation_id?: string
          cost_usd?: number | null
          created_at?: string
          fallback_reason?: string | null
          id?: string
          input_tokens?: number
          kind?: string
          latency_ms?: number | null
          model?: string | null
          output_tokens?: number
          prompt_checksum?: string
          prompt_version?: string
          provenance?: string
          status?: string
          subject_id?: string
          subject_type?: string
          supersedes_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hq_drafts_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_drafts_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "hq_drafts"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_embedding_runs: {
        Row: {
          attempt: number
          cost: number | null
          created_at: string
          dimension: number | null
          failure_reason: string | null
          id: number
          latency_ms: number | null
          memory_id: string | null
          model: string | null
          provider: string | null
          status: string
          tokens: number | null
          worker_id: string
        }
        Insert: {
          attempt?: number
          cost?: number | null
          created_at?: string
          dimension?: number | null
          failure_reason?: string | null
          id?: never
          latency_ms?: number | null
          memory_id?: string | null
          model?: string | null
          provider?: string | null
          status: string
          tokens?: number | null
          worker_id: string
        }
        Update: {
          attempt?: number
          cost?: number | null
          created_at?: string
          dimension?: number | null
          failure_reason?: string | null
          id?: never
          latency_ms?: number | null
          memory_id?: string | null
          model?: string | null
          provider?: string | null
          status?: string
          tokens?: number | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_embedding_runs_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_event_consumers: {
        Row: {
          consumer: string
          last_event_id: number
          updated_at: string
        }
        Insert: {
          consumer: string
          last_event_id?: number
          updated_at?: string
        }
        Update: {
          consumer?: string
          last_event_id?: number
          updated_at?: string
        }
        Relationships: []
      }
      hq_events: {
        Row: {
          actor_id: string | null
          actor_type: string
          causation_id: number | null
          correlation_id: string
          id: number
          object_id: string
          object_type: string
          payload: Json
          severity: string
          target_id: string | null
          target_type: string | null
          ts: string
          verb: string
          visibility: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          causation_id?: number | null
          correlation_id: string
          id?: never
          object_id: string
          object_type: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb: string
          visibility?: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          causation_id?: number | null
          correlation_id?: string
          id?: never
          object_id?: string
          object_type?: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb?: string
          visibility?: string
        }
        Relationships: []
      }
      hq_events_2026_06: {
        Row: {
          actor_id: string | null
          actor_type: string
          causation_id: number | null
          correlation_id: string
          id: number
          object_id: string
          object_type: string
          payload: Json
          severity: string
          target_id: string | null
          target_type: string | null
          ts: string
          verb: string
          visibility: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          causation_id?: number | null
          correlation_id: string
          id?: never
          object_id: string
          object_type: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb: string
          visibility?: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          causation_id?: number | null
          correlation_id?: string
          id?: never
          object_id?: string
          object_type?: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb?: string
          visibility?: string
        }
        Relationships: []
      }
      hq_events_2026_07: {
        Row: {
          actor_id: string | null
          actor_type: string
          causation_id: number | null
          correlation_id: string
          id: number
          object_id: string
          object_type: string
          payload: Json
          severity: string
          target_id: string | null
          target_type: string | null
          ts: string
          verb: string
          visibility: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          causation_id?: number | null
          correlation_id: string
          id?: never
          object_id: string
          object_type: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb: string
          visibility?: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          causation_id?: number | null
          correlation_id?: string
          id?: never
          object_id?: string
          object_type?: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb?: string
          visibility?: string
        }
        Relationships: []
      }
      hq_events_2026_08: {
        Row: {
          actor_id: string | null
          actor_type: string
          causation_id: number | null
          correlation_id: string
          id: number
          object_id: string
          object_type: string
          payload: Json
          severity: string
          target_id: string | null
          target_type: string | null
          ts: string
          verb: string
          visibility: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          causation_id?: number | null
          correlation_id: string
          id?: never
          object_id: string
          object_type: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb: string
          visibility?: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          causation_id?: number | null
          correlation_id?: string
          id?: never
          object_id?: string
          object_type?: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb?: string
          visibility?: string
        }
        Relationships: []
      }
      hq_events_2026_09: {
        Row: {
          actor_id: string | null
          actor_type: string
          causation_id: number | null
          correlation_id: string
          id: number
          object_id: string
          object_type: string
          payload: Json
          severity: string
          target_id: string | null
          target_type: string | null
          ts: string
          verb: string
          visibility: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          causation_id?: number | null
          correlation_id: string
          id?: never
          object_id: string
          object_type: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb: string
          visibility?: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          causation_id?: number | null
          correlation_id?: string
          id?: never
          object_id?: string
          object_type?: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb?: string
          visibility?: string
        }
        Relationships: []
      }
      hq_events_2026_10: {
        Row: {
          actor_id: string | null
          actor_type: string
          causation_id: number | null
          correlation_id: string
          id: number
          object_id: string
          object_type: string
          payload: Json
          severity: string
          target_id: string | null
          target_type: string | null
          ts: string
          verb: string
          visibility: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          causation_id?: number | null
          correlation_id: string
          id?: never
          object_id: string
          object_type: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb: string
          visibility?: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          causation_id?: number | null
          correlation_id?: string
          id?: never
          object_id?: string
          object_type?: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb?: string
          visibility?: string
        }
        Relationships: []
      }
      hq_events_2026_11: {
        Row: {
          actor_id: string | null
          actor_type: string
          causation_id: number | null
          correlation_id: string
          id: number
          object_id: string
          object_type: string
          payload: Json
          severity: string
          target_id: string | null
          target_type: string | null
          ts: string
          verb: string
          visibility: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          causation_id?: number | null
          correlation_id: string
          id?: never
          object_id: string
          object_type: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb: string
          visibility?: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          causation_id?: number | null
          correlation_id?: string
          id?: never
          object_id?: string
          object_type?: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb?: string
          visibility?: string
        }
        Relationships: []
      }
      hq_events_2026_12: {
        Row: {
          actor_id: string | null
          actor_type: string
          causation_id: number | null
          correlation_id: string
          id: number
          object_id: string
          object_type: string
          payload: Json
          severity: string
          target_id: string | null
          target_type: string | null
          ts: string
          verb: string
          visibility: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          causation_id?: number | null
          correlation_id: string
          id?: never
          object_id: string
          object_type: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb: string
          visibility?: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          causation_id?: number | null
          correlation_id?: string
          id?: never
          object_id?: string
          object_type?: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb?: string
          visibility?: string
        }
        Relationships: []
      }
      hq_events_default: {
        Row: {
          actor_id: string | null
          actor_type: string
          causation_id: number | null
          correlation_id: string
          id: number
          object_id: string
          object_type: string
          payload: Json
          severity: string
          target_id: string | null
          target_type: string | null
          ts: string
          verb: string
          visibility: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          causation_id?: number | null
          correlation_id: string
          id?: never
          object_id: string
          object_type: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb: string
          visibility?: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          causation_id?: number | null
          correlation_id?: string
          id?: never
          object_id?: string
          object_type?: string
          payload?: Json
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb?: string
          visibility?: string
        }
        Relationships: []
      }
      hq_memories: {
        Row: {
          access_count: number
          body: string
          bound_task_id: string | null
          confidence: number
          consolidated_into: string | null
          created_at: string
          created_by_email: string | null
          created_by_id: string | null
          department: string | null
          embedded_at: string | null
          embedding: string | null
          embedding_attempts: number
          embedding_checksum: string | null
          embedding_claimed_at: string | null
          embedding_claimed_by: string | null
          embedding_cost: number | null
          embedding_dimension: number | null
          embedding_last_error: string | null
          embedding_latency_ms: number | null
          embedding_model: string | null
          embedding_next_attempt_at: string | null
          embedding_placeholder: Json | null
          embedding_provider: string | null
          embedding_status: string
          embedding_version: string | null
          expires_at: string | null
          id: string
          importance: string
          keywords: string[]
          last_accessed_at: string | null
          last_reinforced_at: string | null
          memory_class: string
          memory_type: string
          organisation_id: string | null
          organisation_name: string | null
          owner_employee_id: string | null
          pinned: boolean
          salience: number
          search_tsv: unknown
          source: string
          status: string
          summary: string
          tags: string[]
          title: string
          updated_at: string
          version: number
          visibility: string
        }
        Insert: {
          access_count?: number
          body?: string
          bound_task_id?: string | null
          confidence?: number
          consolidated_into?: string | null
          created_at?: string
          created_by_email?: string | null
          created_by_id?: string | null
          department?: string | null
          embedded_at?: string | null
          embedding?: string | null
          embedding_attempts?: number
          embedding_checksum?: string | null
          embedding_claimed_at?: string | null
          embedding_claimed_by?: string | null
          embedding_cost?: number | null
          embedding_dimension?: number | null
          embedding_last_error?: string | null
          embedding_latency_ms?: number | null
          embedding_model?: string | null
          embedding_next_attempt_at?: string | null
          embedding_placeholder?: Json | null
          embedding_provider?: string | null
          embedding_status?: string
          embedding_version?: string | null
          expires_at?: string | null
          id?: string
          importance?: string
          keywords?: string[]
          last_accessed_at?: string | null
          last_reinforced_at?: string | null
          memory_class?: string
          memory_type: string
          organisation_id?: string | null
          organisation_name?: string | null
          owner_employee_id?: string | null
          pinned?: boolean
          salience?: number
          search_tsv?: unknown
          source?: string
          status?: string
          summary?: string
          tags?: string[]
          title: string
          updated_at?: string
          version?: number
          visibility?: string
        }
        Update: {
          access_count?: number
          body?: string
          bound_task_id?: string | null
          confidence?: number
          consolidated_into?: string | null
          created_at?: string
          created_by_email?: string | null
          created_by_id?: string | null
          department?: string | null
          embedded_at?: string | null
          embedding?: string | null
          embedding_attempts?: number
          embedding_checksum?: string | null
          embedding_claimed_at?: string | null
          embedding_claimed_by?: string | null
          embedding_cost?: number | null
          embedding_dimension?: number | null
          embedding_last_error?: string | null
          embedding_latency_ms?: number | null
          embedding_model?: string | null
          embedding_next_attempt_at?: string | null
          embedding_placeholder?: Json | null
          embedding_provider?: string | null
          embedding_status?: string
          embedding_version?: string | null
          expires_at?: string | null
          id?: string
          importance?: string
          keywords?: string[]
          last_accessed_at?: string | null
          last_reinforced_at?: string | null
          memory_class?: string
          memory_type?: string
          organisation_id?: string | null
          organisation_name?: string | null
          owner_employee_id?: string | null
          pinned?: boolean
          salience?: number
          search_tsv?: unknown
          source?: string
          status?: string
          summary?: string
          tags?: string[]
          title?: string
          updated_at?: string
          version?: number
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_memories_bound_task_id_fkey"
            columns: ["bound_task_id"]
            isOneToOne: false
            referencedRelation: "hq_ai_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_memories_consolidated_into_fkey"
            columns: ["consolidated_into"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_memories_created_by_id_fkey"
            columns: ["created_by_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_memories_memory_type_fkey"
            columns: ["memory_type"]
            isOneToOne: false
            referencedRelation: "hq_memory_types"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "hq_memories_owner_employee_id_fkey"
            columns: ["owner_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_memories_source_fkey"
            columns: ["source"]
            isOneToOne: false
            referencedRelation: "hq_memory_sources"
            referencedColumns: ["slug"]
          },
        ]
      }
      hq_memory_access_grants: {
        Row: {
          created_at: string
          created_by_email: string | null
          grantee_type: string
          grantee_value: string
          id: string
          memory_id: string
        }
        Insert: {
          created_at?: string
          created_by_email?: string | null
          grantee_type: string
          grantee_value: string
          id?: string
          memory_id: string
        }
        Update: {
          created_at?: string
          created_by_email?: string | null
          grantee_type?: string
          grantee_value?: string
          id?: string
          memory_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_memory_access_grants_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_memory_employee_links: {
        Row: {
          ai_employee_id: string
          created_at: string
          created_by_email: string | null
          id: string
          link_kind: string
          memory_id: string
        }
        Insert: {
          ai_employee_id: string
          created_at?: string
          created_by_email?: string | null
          id?: string
          link_kind?: string
          memory_id: string
        }
        Update: {
          ai_employee_id?: string
          created_at?: string
          created_by_email?: string | null
          id?: string
          link_kind?: string
          memory_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_memory_employee_links_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_memory_employee_links_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_memory_events: {
        Row: {
          actor_email: string | null
          ai_employee_id: string | null
          created_at: string
          detail: Json | null
          event_type: string
          id: string
          memory_id: string
        }
        Insert: {
          actor_email?: string | null
          ai_employee_id?: string | null
          created_at?: string
          detail?: Json | null
          event_type: string
          id?: string
          memory_id: string
        }
        Update: {
          actor_email?: string | null
          ai_employee_id?: string | null
          created_at?: string
          detail?: Json | null
          event_type?: string
          id?: string
          memory_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_memory_events_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_memory_events_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_memory_relationships: {
        Row: {
          created_at: string
          created_by_email: string | null
          entity_id: string | null
          entity_label: string
          entity_type: string
          id: string
          memory_id: string
          relation: string
        }
        Insert: {
          created_at?: string
          created_by_email?: string | null
          entity_id?: string | null
          entity_label: string
          entity_type: string
          id?: string
          memory_id: string
          relation?: string
        }
        Update: {
          created_at?: string
          created_by_email?: string | null
          entity_id?: string | null
          entity_label?: string
          entity_type?: string
          id?: string
          memory_id?: string
          relation?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_memory_relationships_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_memory_sources: {
        Row: {
          category: string
          created_at: string
          is_active: boolean
          label: string
          slug: string
          sort_order: number
        }
        Insert: {
          category?: string
          created_at?: string
          is_active?: boolean
          label: string
          slug: string
          sort_order?: number
        }
        Update: {
          category?: string
          created_at?: string
          is_active?: boolean
          label?: string
          slug?: string
          sort_order?: number
        }
        Relationships: []
      }
      hq_memory_types: {
        Row: {
          accent: string
          created_at: string
          default_department: string | null
          description: string
          icon: string
          is_active: boolean
          label: string
          slug: string
          sort_order: number
        }
        Insert: {
          accent?: string
          created_at?: string
          default_department?: string | null
          description?: string
          icon?: string
          is_active?: boolean
          label: string
          slug: string
          sort_order?: number
        }
        Update: {
          accent?: string
          created_at?: string
          default_department?: string | null
          description?: string
          icon?: string
          is_active?: boolean
          label?: string
          slug?: string
          sort_order?: number
        }
        Relationships: []
      }
      hq_memory_versions: {
        Row: {
          body: string
          created_at: string
          department: string | null
          edited_by_email: string | null
          id: string
          importance: string | null
          memory_id: string
          memory_type: string | null
          status: string | null
          summary: string
          tags: string[]
          title: string
          version: number
        }
        Insert: {
          body?: string
          created_at?: string
          department?: string | null
          edited_by_email?: string | null
          id?: string
          importance?: string | null
          memory_id: string
          memory_type?: string | null
          status?: string | null
          summary?: string
          tags?: string[]
          title: string
          version: number
        }
        Update: {
          body?: string
          created_at?: string
          department?: string | null
          edited_by_email?: string | null
          id?: string
          importance?: string | null
          memory_id?: string
          memory_type?: string | null
          status?: string | null
          summary?: string
          tags?: string[]
          title?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "hq_memory_versions_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_sales_ai_tasks: {
        Row: {
          assigned_ai_employee_id: string | null
          company_id: string | null
          contact_id: string | null
          created_at: string
          created_by_email: string | null
          dedupe_key: string | null
          error_message: string | null
          finished_at: string | null
          id: string
          max_retries: number
          payload: Json | null
          priority: string
          priority_rank: number | null
          result: Json | null
          retry_count: number
          scheduled_at: string | null
          source: string
          started_at: string | null
          status: string
          task_type: string
          updated_at: string
        }
        Insert: {
          assigned_ai_employee_id?: string | null
          company_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by_email?: string | null
          dedupe_key?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          max_retries?: number
          payload?: Json | null
          priority?: string
          priority_rank?: number | null
          result?: Json | null
          retry_count?: number
          scheduled_at?: string | null
          source?: string
          started_at?: string | null
          status?: string
          task_type: string
          updated_at?: string
        }
        Update: {
          assigned_ai_employee_id?: string | null
          company_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by_email?: string | null
          dedupe_key?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          max_retries?: number
          payload?: Json | null
          priority?: string
          priority_rank?: number | null
          result?: Json | null
          retry_count?: number
          scheduled_at?: string | null
          source?: string
          started_at?: string | null
          status?: string
          task_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_ai_tasks_assigned_ai_employee_id_fkey"
            columns: ["assigned_ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_ai_tasks_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_ai_tasks_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_ai_tasks_source_fkey"
            columns: ["source"]
            isOneToOne: false
            referencedRelation: "hq_sales_sources"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "hq_sales_ai_tasks_task_type_fkey"
            columns: ["task_type"]
            isOneToOne: false
            referencedRelation: "hq_sales_task_types"
            referencedColumns: ["slug"]
          },
        ]
      }
      hq_sales_call_scripts: {
        Row: {
          ai_employee_id: string | null
          body: string
          category: string
          created_at: string
          created_by_email: string | null
          estimated_duration_seconds: number | null
          generated_by: string
          id: string
          model: string | null
          name: string
          opening: string
          questions: string[]
          search_tsv: unknown
          status: string
          summary: string
          tags: string[]
          talking_points: string[]
          target_persona: string | null
          target_status: string | null
          updated_at: string
          usage_count: number
          version: number
        }
        Insert: {
          ai_employee_id?: string | null
          body?: string
          category?: string
          created_at?: string
          created_by_email?: string | null
          estimated_duration_seconds?: number | null
          generated_by?: string
          id?: string
          model?: string | null
          name: string
          opening?: string
          questions?: string[]
          search_tsv?: unknown
          status?: string
          summary?: string
          tags?: string[]
          talking_points?: string[]
          target_persona?: string | null
          target_status?: string | null
          updated_at?: string
          usage_count?: number
          version?: number
        }
        Update: {
          ai_employee_id?: string | null
          body?: string
          category?: string
          created_at?: string
          created_by_email?: string | null
          estimated_duration_seconds?: number | null
          generated_by?: string
          id?: string
          model?: string | null
          name?: string
          opening?: string
          questions?: string[]
          search_tsv?: unknown
          status?: string
          summary?: string
          tags?: string[]
          talking_points?: string[]
          target_persona?: string | null
          target_status?: string | null
          updated_at?: string
          usage_count?: number
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_call_scripts_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_sales_calls: {
        Row: {
          ai_employee_id: string | null
          ai_task_id: string | null
          company_id: string
          contact_id: string | null
          created_at: string
          created_by_email: string | null
          direction: string
          duration_seconds: number | null
          ended_at: string | null
          follow_up_at: string | null
          follow_up_done: boolean
          follow_up_notes: string
          generated_by: string
          id: string
          memory_id: string | null
          metadata: Json | null
          model: string | null
          notes: string
          objections_raised: string[]
          objective: string
          outcome: string
          priority: string
          priority_rank: number | null
          recording_url: string | null
          scheduled_at: string | null
          script_id: string | null
          search_tsv: unknown
          sentiment: string
          sentiment_score: number | null
          source: string
          started_at: string | null
          status: string
          summary: string
          tags: string[]
          transcript: string
          updated_at: string
        }
        Insert: {
          ai_employee_id?: string | null
          ai_task_id?: string | null
          company_id: string
          contact_id?: string | null
          created_at?: string
          created_by_email?: string | null
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          follow_up_at?: string | null
          follow_up_done?: boolean
          follow_up_notes?: string
          generated_by?: string
          id?: string
          memory_id?: string | null
          metadata?: Json | null
          model?: string | null
          notes?: string
          objections_raised?: string[]
          objective?: string
          outcome?: string
          priority?: string
          priority_rank?: number | null
          recording_url?: string | null
          scheduled_at?: string | null
          script_id?: string | null
          search_tsv?: unknown
          sentiment?: string
          sentiment_score?: number | null
          source?: string
          started_at?: string | null
          status?: string
          summary?: string
          tags?: string[]
          transcript?: string
          updated_at?: string
        }
        Update: {
          ai_employee_id?: string | null
          ai_task_id?: string | null
          company_id?: string
          contact_id?: string | null
          created_at?: string
          created_by_email?: string | null
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          follow_up_at?: string | null
          follow_up_done?: boolean
          follow_up_notes?: string
          generated_by?: string
          id?: string
          memory_id?: string | null
          metadata?: Json | null
          model?: string | null
          notes?: string
          objections_raised?: string[]
          objective?: string
          outcome?: string
          priority?: string
          priority_rank?: number | null
          recording_url?: string | null
          scheduled_at?: string | null
          script_id?: string | null
          search_tsv?: unknown
          sentiment?: string
          sentiment_score?: number | null
          source?: string
          started_at?: string | null
          status?: string
          summary?: string
          tags?: string[]
          transcript?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_calls_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_calls_ai_task_id_fkey"
            columns: ["ai_task_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_ai_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_calls_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_calls_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_calls_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_calls_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_call_scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_calls_source_fkey"
            columns: ["source"]
            isOneToOne: false
            referencedRelation: "hq_sales_sources"
            referencedColumns: ["slug"]
          },
        ]
      }
      hq_sales_channel_types: {
        Row: {
          category: string
          created_at: string
          is_active: boolean
          label: string
          slug: string
          sort_order: number
        }
        Insert: {
          category?: string
          created_at?: string
          is_active?: boolean
          label: string
          slug: string
          sort_order?: number
        }
        Update: {
          category?: string
          created_at?: string
          is_active?: boolean
          label?: string
          slug?: string
          sort_order?: number
        }
        Relationships: []
      }
      hq_sales_channels: {
        Row: {
          ai_employee_id: string | null
          channel_type: string
          company_id: string
          contact_id: string | null
          created_at: string
          created_by_email: string | null
          generated_by: string
          id: string
          is_primary: boolean
          is_verified: boolean
          label: string | null
          location_id: string | null
          metadata: Json | null
          model: string | null
          status: string
          updated_at: string
          value: string
        }
        Insert: {
          ai_employee_id?: string | null
          channel_type: string
          company_id: string
          contact_id?: string | null
          created_at?: string
          created_by_email?: string | null
          generated_by?: string
          id?: string
          is_primary?: boolean
          is_verified?: boolean
          label?: string | null
          location_id?: string | null
          metadata?: Json | null
          model?: string | null
          status?: string
          updated_at?: string
          value: string
        }
        Update: {
          ai_employee_id?: string | null
          channel_type?: string
          company_id?: string
          contact_id?: string | null
          created_at?: string
          created_by_email?: string | null
          generated_by?: string
          id?: string
          is_primary?: boolean
          is_verified?: boolean
          label?: string | null
          location_id?: string | null
          metadata?: Json | null
          model?: string | null
          status?: string
          updated_at?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_channels_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_channels_channel_type_fkey"
            columns: ["channel_type"]
            isOneToOne: false
            referencedRelation: "hq_sales_channel_types"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "hq_sales_channels_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_channels_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_channels_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_sales_companies: {
        Row: {
          ai_qualification_score: number | null
          annual_turnover_gbp: number | null
          assigned_to_email: string | null
          companies_house_number: string | null
          companies_house_url: string | null
          construction_sector: string | null
          country: string
          county: string | null
          created_at: string
          created_by_email: string | null
          created_by_id: string | null
          crm_score: number | null
          digital_maturity_score: number | null
          domain: string | null
          employee_count: number | null
          enrichment: Json | null
          estimated_deal_value_gbp: number | null
          estimated_software_spend_gbp: number | null
          facebook_url: string | null
          fleet_size: number | null
          growth_score: number | null
          hiring_activity_score: number | null
          id: string
          industry: string | null
          instagram_url: string | null
          last_researched_at: string | null
          linkedin_url: string | null
          location: string | null
          marketing_quality_score: number | null
          name: string
          primary_email: string | null
          primary_phone: string | null
          region: string | null
          revenue_estimate_gbp: number | null
          search_tsv: unknown
          software_used: string[]
          source: string
          staff_size: number | null
          status: string
          summary: string
          tags: string[]
          updated_at: string
          website: string | null
          website_quality_score: number | null
          website_technology: string[]
        }
        Insert: {
          ai_qualification_score?: number | null
          annual_turnover_gbp?: number | null
          assigned_to_email?: string | null
          companies_house_number?: string | null
          companies_house_url?: string | null
          construction_sector?: string | null
          country?: string
          county?: string | null
          created_at?: string
          created_by_email?: string | null
          created_by_id?: string | null
          crm_score?: number | null
          digital_maturity_score?: number | null
          domain?: string | null
          employee_count?: number | null
          enrichment?: Json | null
          estimated_deal_value_gbp?: number | null
          estimated_software_spend_gbp?: number | null
          facebook_url?: string | null
          fleet_size?: number | null
          growth_score?: number | null
          hiring_activity_score?: number | null
          id?: string
          industry?: string | null
          instagram_url?: string | null
          last_researched_at?: string | null
          linkedin_url?: string | null
          location?: string | null
          marketing_quality_score?: number | null
          name: string
          primary_email?: string | null
          primary_phone?: string | null
          region?: string | null
          revenue_estimate_gbp?: number | null
          search_tsv?: unknown
          software_used?: string[]
          source?: string
          staff_size?: number | null
          status?: string
          summary?: string
          tags?: string[]
          updated_at?: string
          website?: string | null
          website_quality_score?: number | null
          website_technology?: string[]
        }
        Update: {
          ai_qualification_score?: number | null
          annual_turnover_gbp?: number | null
          assigned_to_email?: string | null
          companies_house_number?: string | null
          companies_house_url?: string | null
          construction_sector?: string | null
          country?: string
          county?: string | null
          created_at?: string
          created_by_email?: string | null
          created_by_id?: string | null
          crm_score?: number | null
          digital_maturity_score?: number | null
          domain?: string | null
          employee_count?: number | null
          enrichment?: Json | null
          estimated_deal_value_gbp?: number | null
          estimated_software_spend_gbp?: number | null
          facebook_url?: string | null
          fleet_size?: number | null
          growth_score?: number | null
          hiring_activity_score?: number | null
          id?: string
          industry?: string | null
          instagram_url?: string | null
          last_researched_at?: string | null
          linkedin_url?: string | null
          location?: string | null
          marketing_quality_score?: number | null
          name?: string
          primary_email?: string | null
          primary_phone?: string | null
          region?: string | null
          revenue_estimate_gbp?: number | null
          search_tsv?: unknown
          software_used?: string[]
          source?: string
          staff_size?: number | null
          status?: string
          summary?: string
          tags?: string[]
          updated_at?: string
          website?: string | null
          website_quality_score?: number | null
          website_technology?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_companies_created_by_id_fkey"
            columns: ["created_by_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_companies_source_fkey"
            columns: ["source"]
            isOneToOne: false
            referencedRelation: "hq_sales_sources"
            referencedColumns: ["slug"]
          },
        ]
      }
      hq_sales_contacts: {
        Row: {
          company_id: string
          created_at: string
          created_by_email: string | null
          email: string | null
          full_name: string
          id: string
          is_decision_maker: boolean
          is_primary: boolean
          linkedin_url: string | null
          notes: string
          phone: string | null
          search_tsv: unknown
          seniority: string
          title: string | null
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by_email?: string | null
          email?: string | null
          full_name: string
          id?: string
          is_decision_maker?: boolean
          is_primary?: boolean
          linkedin_url?: string | null
          notes?: string
          phone?: string | null
          search_tsv?: unknown
          seniority?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by_email?: string | null
          email?: string | null
          full_name?: string
          id?: string
          is_decision_maker?: boolean
          is_primary?: boolean
          linkedin_url?: string | null
          notes?: string
          phone?: string | null
          search_tsv?: unknown
          seniority?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_contacts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_companies"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_sales_external_records: {
        Row: {
          company_id: string | null
          contact_id: string | null
          created_at: string
          created_by_email: string | null
          external_id: string | null
          external_url: string | null
          id: string
          integration: string
          location_id: string | null
          payload: Json | null
          status: string
          synced_at: string | null
          updated_at: string
        }
        Insert: {
          company_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by_email?: string | null
          external_id?: string | null
          external_url?: string | null
          id?: string
          integration: string
          location_id?: string | null
          payload?: Json | null
          status?: string
          synced_at?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by_email?: string | null
          external_id?: string | null
          external_url?: string | null
          id?: string
          integration?: string
          location_id?: string | null
          payload?: Json | null
          status?: string
          synced_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_external_records_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_external_records_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_external_records_integration_fkey"
            columns: ["integration"]
            isOneToOne: false
            referencedRelation: "hq_sales_integrations"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "hq_sales_external_records_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_sales_integrations: {
        Row: {
          category: string
          created_at: string
          is_active: boolean
          label: string
          slug: string
          sort_order: number
          status: string
        }
        Insert: {
          category?: string
          created_at?: string
          is_active?: boolean
          label: string
          slug: string
          sort_order?: number
          status?: string
        }
        Update: {
          category?: string
          created_at?: string
          is_active?: boolean
          label?: string
          slug?: string
          sort_order?: number
          status?: string
        }
        Relationships: []
      }
      hq_sales_learnings: {
        Row: {
          ai_employee_id: string | null
          channel: string | null
          company_id: string | null
          confidence: number | null
          context: string
          created_at: string
          created_by_email: string | null
          generated_by: string
          id: string
          last_used_at: string | null
          memory_id: string | null
          metrics: Json | null
          model: string | null
          pattern_type: string
          prompt: string
          result: string
          search_tsv: unknown
          source: string
          source_call_id: string | null
          source_event_id: string | null
          source_objection_id: string | null
          status: string
          summary: string
          supporting_points: string[]
          tags: string[]
          times_used: number
          times_won: number
          title: string
          updated_at: string
          win_rate: number | null
        }
        Insert: {
          ai_employee_id?: string | null
          channel?: string | null
          company_id?: string | null
          confidence?: number | null
          context?: string
          created_at?: string
          created_by_email?: string | null
          generated_by?: string
          id?: string
          last_used_at?: string | null
          memory_id?: string | null
          metrics?: Json | null
          model?: string | null
          pattern_type?: string
          prompt?: string
          result?: string
          search_tsv?: unknown
          source?: string
          source_call_id?: string | null
          source_event_id?: string | null
          source_objection_id?: string | null
          status?: string
          summary?: string
          supporting_points?: string[]
          tags?: string[]
          times_used?: number
          times_won?: number
          title: string
          updated_at?: string
          win_rate?: number | null
        }
        Update: {
          ai_employee_id?: string | null
          channel?: string | null
          company_id?: string | null
          confidence?: number | null
          context?: string
          created_at?: string
          created_by_email?: string | null
          generated_by?: string
          id?: string
          last_used_at?: string | null
          memory_id?: string | null
          metrics?: Json | null
          model?: string | null
          pattern_type?: string
          prompt?: string
          result?: string
          search_tsv?: unknown
          source?: string
          source_call_id?: string | null
          source_event_id?: string | null
          source_objection_id?: string | null
          status?: string
          summary?: string
          supporting_points?: string[]
          tags?: string[]
          times_used?: number
          times_won?: number
          title?: string
          updated_at?: string
          win_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_learnings_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_learnings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_learnings_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_learnings_source_call_id_fkey"
            columns: ["source_call_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_learnings_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_timeline_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_learnings_source_fkey"
            columns: ["source"]
            isOneToOne: false
            referencedRelation: "hq_sales_sources"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "hq_sales_learnings_source_objection_id_fkey"
            columns: ["source_objection_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_objections"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_sales_locations: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          ai_employee_id: string | null
          city: string | null
          company_id: string
          country: string
          county: string | null
          created_at: string
          created_by_email: string | null
          generated_by: string
          id: string
          is_headquarters: boolean
          is_primary: boolean
          label: string | null
          latitude: number | null
          longitude: number | null
          metadata: Json | null
          model: string | null
          notes: string
          phone: string | null
          postcode: string | null
          region: string | null
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          ai_employee_id?: string | null
          city?: string | null
          company_id: string
          country?: string
          county?: string | null
          created_at?: string
          created_by_email?: string | null
          generated_by?: string
          id?: string
          is_headquarters?: boolean
          is_primary?: boolean
          label?: string | null
          latitude?: number | null
          longitude?: number | null
          metadata?: Json | null
          model?: string | null
          notes?: string
          phone?: string | null
          postcode?: string | null
          region?: string | null
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          ai_employee_id?: string | null
          city?: string | null
          company_id?: string
          country?: string
          county?: string | null
          created_at?: string
          created_by_email?: string | null
          generated_by?: string
          id?: string
          is_headquarters?: boolean
          is_primary?: boolean
          label?: string | null
          latitude?: number | null
          longitude?: number | null
          metadata?: Json | null
          model?: string | null
          notes?: string
          phone?: string | null
          postcode?: string | null
          region?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_locations_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_locations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_companies"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_sales_objections: {
        Row: {
          ai_employee_id: string | null
          category: string
          confidence: number | null
          created_at: string
          created_by_email: string | null
          follow_up: string
          generated_by: string
          id: string
          memory_id: string | null
          model: string | null
          objection: string
          response: string
          search_tsv: unknown
          status: string
          supporting_points: string[]
          tags: string[]
          times_used: number
          updated_at: string
          win_rate: number | null
        }
        Insert: {
          ai_employee_id?: string | null
          category?: string
          confidence?: number | null
          created_at?: string
          created_by_email?: string | null
          follow_up?: string
          generated_by?: string
          id?: string
          memory_id?: string | null
          model?: string | null
          objection: string
          response?: string
          search_tsv?: unknown
          status?: string
          supporting_points?: string[]
          tags?: string[]
          times_used?: number
          updated_at?: string
          win_rate?: number | null
        }
        Update: {
          ai_employee_id?: string | null
          category?: string
          confidence?: number | null
          created_at?: string
          created_by_email?: string | null
          follow_up?: string
          generated_by?: string
          id?: string
          memory_id?: string | null
          model?: string | null
          objection?: string
          response?: string
          search_tsv?: unknown
          status?: string
          supporting_points?: string[]
          tags?: string[]
          times_used?: number
          updated_at?: string
          win_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_objections_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_objections_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_sales_recommendations: {
        Row: {
          ai_employee_id: string | null
          authored_by_email: string | null
          best_salesperson: string | null
          best_time_to_call: string
          company_id: string
          created_at: string
          follow_up_schedule: string
          follow_up_steps: Json | null
          generated_by: string
          id: string
          key_features: string[]
          likely_objections: string[]
          model: string | null
          recommended_plan: string | null
          recommended_price_gbp: number | null
          recommended_pricing: string
          status: string
          updated_at: string
          why_buy: string
        }
        Insert: {
          ai_employee_id?: string | null
          authored_by_email?: string | null
          best_salesperson?: string | null
          best_time_to_call?: string
          company_id: string
          created_at?: string
          follow_up_schedule?: string
          follow_up_steps?: Json | null
          generated_by?: string
          id?: string
          key_features?: string[]
          likely_objections?: string[]
          model?: string | null
          recommended_plan?: string | null
          recommended_price_gbp?: number | null
          recommended_pricing?: string
          status?: string
          updated_at?: string
          why_buy?: string
        }
        Update: {
          ai_employee_id?: string | null
          authored_by_email?: string | null
          best_salesperson?: string | null
          best_time_to_call?: string
          company_id?: string
          created_at?: string
          follow_up_schedule?: string
          follow_up_steps?: Json | null
          generated_by?: string
          id?: string
          key_features?: string[]
          likely_objections?: string[]
          model?: string | null
          recommended_plan?: string | null
          recommended_price_gbp?: number | null
          recommended_pricing?: string
          status?: string
          updated_at?: string
          why_buy?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_recommendations_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_recommendations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_companies"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_sales_research_reports: {
        Row: {
          ai_employee_id: string | null
          authored_by_email: string | null
          best_angle: string
          company_id: string
          created_at: string
          estimated_software_spend_gbp: number | null
          estimated_spend_note: string
          generated_by: string
          id: string
          likelihood_band: string
          likelihood_score: number | null
          memory_id: string | null
          model: string | null
          opening_line: string
          pain_points: string[]
          recommended_follow_up: string
          risk_assessment: string
          risk_level: string
          search_tsv: unknown
          status: string
          summary: string
          updated_at: string
        }
        Insert: {
          ai_employee_id?: string | null
          authored_by_email?: string | null
          best_angle?: string
          company_id: string
          created_at?: string
          estimated_software_spend_gbp?: number | null
          estimated_spend_note?: string
          generated_by?: string
          id?: string
          likelihood_band?: string
          likelihood_score?: number | null
          memory_id?: string | null
          model?: string | null
          opening_line?: string
          pain_points?: string[]
          recommended_follow_up?: string
          risk_assessment?: string
          risk_level?: string
          search_tsv?: unknown
          status?: string
          summary?: string
          updated_at?: string
        }
        Update: {
          ai_employee_id?: string | null
          authored_by_email?: string | null
          best_angle?: string
          company_id?: string
          created_at?: string
          estimated_software_spend_gbp?: number | null
          estimated_spend_note?: string
          generated_by?: string
          id?: string
          likelihood_band?: string
          likelihood_score?: number | null
          memory_id?: string | null
          model?: string | null
          opening_line?: string
          pain_points?: string[]
          recommended_follow_up?: string
          risk_assessment?: string
          risk_level?: string
          search_tsv?: unknown
          status?: string
          summary?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_research_reports_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_research_reports_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_research_reports_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_sales_sources: {
        Row: {
          category: string
          created_at: string
          is_active: boolean
          label: string
          slug: string
          sort_order: number
        }
        Insert: {
          category?: string
          created_at?: string
          is_active?: boolean
          label: string
          slug: string
          sort_order?: number
        }
        Update: {
          category?: string
          created_at?: string
          is_active?: boolean
          label?: string
          slug?: string
          sort_order?: number
        }
        Relationships: []
      }
      hq_sales_task_types: {
        Row: {
          category: string
          created_at: string
          is_active: boolean
          label: string
          slug: string
          sort_order: number
        }
        Insert: {
          category?: string
          created_at?: string
          is_active?: boolean
          label: string
          slug: string
          sort_order?: number
        }
        Update: {
          category?: string
          created_at?: string
          is_active?: boolean
          label?: string
          slug?: string
          sort_order?: number
        }
        Relationships: []
      }
      hq_sales_timeline_events: {
        Row: {
          actor_email: string | null
          ai_employee_id: string | null
          body: string
          company_id: string
          contact_id: string | null
          created_at: string
          direction: string
          event_type: string
          id: string
          memory_id: string | null
          metadata: Json | null
          occurred_at: string
          outcome: string | null
          search_tsv: unknown
          source: string
          subject: string | null
        }
        Insert: {
          actor_email?: string | null
          ai_employee_id?: string | null
          body?: string
          company_id: string
          contact_id?: string | null
          created_at?: string
          direction?: string
          event_type: string
          id?: string
          memory_id?: string | null
          metadata?: Json | null
          occurred_at?: string
          outcome?: string | null
          search_tsv?: unknown
          source?: string
          subject?: string | null
        }
        Update: {
          actor_email?: string | null
          ai_employee_id?: string | null
          body?: string
          company_id?: string
          contact_id?: string | null
          created_at?: string
          direction?: string
          event_type?: string
          id?: string
          memory_id?: string | null
          metadata?: Json | null
          occurred_at?: string
          outcome?: string | null
          search_tsv?: unknown
          source?: string
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hq_sales_timeline_events_ai_employee_id_fkey"
            columns: ["ai_employee_id"]
            isOneToOne: false
            referencedRelation: "ai_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_timeline_events_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_timeline_events_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "hq_sales_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_timeline_events_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "hq_memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_sales_timeline_events_source_fkey"
            columns: ["source"]
            isOneToOne: false
            referencedRelation: "hq_sales_sources"
            referencedColumns: ["slug"]
          },
        ]
      }
      hq_settings: {
        Row: {
          data: Json
          id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          data?: Json
          id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          data?: Json
          id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      hq_timeline: {
        Row: {
          actor_id: string | null
          actor_type: string
          causation_id: number | null
          correlation_id: string
          event_id: number
          namespace: string | null
          object_id: string
          object_type: string
          payload: Json
          projected_at: string
          search: unknown
          severity: string
          target_id: string | null
          target_type: string | null
          ts: string
          verb: string
          visibility: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          causation_id?: number | null
          correlation_id: string
          event_id: number
          namespace?: string | null
          object_id: string
          object_type: string
          payload?: Json
          projected_at?: string
          search?: unknown
          severity: string
          target_id?: string | null
          target_type?: string | null
          ts: string
          verb: string
          visibility?: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          causation_id?: number | null
          correlation_id?: string
          event_id?: number
          namespace?: string | null
          object_id?: string
          object_type?: string
          payload?: Json
          projected_at?: string
          search?: unknown
          severity?: string
          target_id?: string | null
          target_type?: string | null
          ts?: string
          verb?: string
          visibility?: string
        }
        Relationships: []
      }
      impersonation_sessions: {
        Row: {
          admin_email: string
          admin_user_id: string | null
          created_at: string
          ended_at: string | null
          id: string
          ip_address: string | null
          reason: string | null
          started_at: string
          target_org_id: string
          target_user_id: string | null
          user_agent: string | null
        }
        Insert: {
          admin_email: string
          admin_user_id?: string | null
          created_at?: string
          ended_at?: string | null
          id?: string
          ip_address?: string | null
          reason?: string | null
          started_at?: string
          target_org_id: string
          target_user_id?: string | null
          user_agent?: string | null
        }
        Update: {
          admin_email?: string
          admin_user_id?: string | null
          created_at?: string
          ended_at?: string | null
          id?: string
          ip_address?: string | null
          reason?: string | null
          started_at?: string
          target_org_id?: string
          target_user_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "impersonation_sessions_admin_user_id_fkey"
            columns: ["admin_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "impersonation_sessions_target_org_id_fkey"
            columns: ["target_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "impersonation_sessions_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      import_audit: {
        Row: {
          created_at: string
          id: string
          import_id: string
          import_row_id: string | null
          org_id: string
          target_id: string
          target_table: string
        }
        Insert: {
          created_at?: string
          id?: string
          import_id: string
          import_row_id?: string | null
          org_id: string
          target_id: string
          target_table: string
        }
        Update: {
          created_at?: string
          id?: string
          import_id?: string
          import_row_id?: string | null
          org_id?: string
          target_id?: string
          target_table?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_audit_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_audit_import_row_id_fkey"
            columns: ["import_row_id"]
            isOneToOne: false
            referencedRelation: "import_rows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_audit_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      import_files: {
        Row: {
          created_at: string
          filename: string
          id: string
          import_id: string
          mime_type: string | null
          org_id: string
          row_count: number
          size_bytes: number | null
          storage_path: string
        }
        Insert: {
          created_at?: string
          filename: string
          id?: string
          import_id: string
          mime_type?: string | null
          org_id: string
          row_count?: number
          size_bytes?: number | null
          storage_path: string
        }
        Update: {
          created_at?: string
          filename?: string
          id?: string
          import_id?: string
          mime_type?: string | null
          org_id?: string
          row_count?: number
          size_bytes?: number | null
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_files_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_files_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      import_rows: {
        Row: {
          confidence: number
          created_at: string
          duplicate_of_id: string | null
          entity_type: string | null
          error_message: string | null
          file_id: string
          id: string
          import_id: string
          mapped: Json | null
          org_id: string
          raw: Json
          source_row_number: number
          status: string
          target_id: string | null
          target_table: string | null
          updated_at: string
        }
        Insert: {
          confidence?: number
          created_at?: string
          duplicate_of_id?: string | null
          entity_type?: string | null
          error_message?: string | null
          file_id: string
          id?: string
          import_id: string
          mapped?: Json | null
          org_id: string
          raw: Json
          source_row_number: number
          status?: string
          target_id?: string | null
          target_table?: string | null
          updated_at?: string
        }
        Update: {
          confidence?: number
          created_at?: string
          duplicate_of_id?: string | null
          entity_type?: string | null
          error_message?: string | null
          file_id?: string
          id?: string
          import_id?: string
          mapped?: Json | null
          org_id?: string
          raw?: Json
          source_row_number?: number
          status?: string
          target_id?: string | null
          target_table?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_rows_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "import_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      imports: {
        Row: {
          committed_at: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string
          org_id: string
          rolled_back_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          committed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          org_id: string
          rolled_back_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          committed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          org_id?: string
          rolled_back_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "imports_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "imports_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_enquiries: {
        Row: {
          ai_confidence: number | null
          ai_summary: string | null
          budget_gbp: number | null
          caller: string | null
          channel: string
          conversation_id: string | null
          created_at: string
          error_message: string | null
          id: string
          job_type: string | null
          lead_id: string | null
          org_id: string
          postcode: string | null
          processed_at: string | null
          raw_text: string | null
          status: string
          urgency: string | null
        }
        Insert: {
          ai_confidence?: number | null
          ai_summary?: string | null
          budget_gbp?: number | null
          caller?: string | null
          channel: string
          conversation_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          org_id: string
          postcode?: string | null
          processed_at?: string | null
          raw_text?: string | null
          status?: string
          urgency?: string | null
        }
        Update: {
          ai_confidence?: number | null
          ai_summary?: string | null
          budget_gbp?: number | null
          caller?: string | null
          channel?: string
          conversation_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          org_id?: string
          postcode?: string | null
          processed_at?: string | null
          raw_text?: string | null
          status?: string
          urgency?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inbound_enquiries_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "receptionist_conversation_list"
            referencedColumns: ["conversation_id"]
          },
          {
            foreignKeyName: "inbound_enquiries_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "receptionist_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_enquiries_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_enquiries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      internal_notes: {
        Row: {
          archived_at: string | null
          author_email: string
          author_user_id: string | null
          body: string
          category: string
          created_at: string
          id: string
          org_id: string
          pinned: boolean
          priority: string
          title: string | null
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          author_email: string
          author_user_id?: string | null
          body: string
          category?: string
          created_at?: string
          id?: string
          org_id: string
          pinned?: boolean
          priority?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          author_email?: string
          author_user_id?: string | null
          body?: string
          category?: string
          created_at?: string
          id?: string
          org_id?: string
          pinned?: boolean
          priority?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "internal_notes_author_user_id_fkey"
            columns: ["author_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "internal_notes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_items: {
        Row: {
          created_at: string
          description: string
          id: string
          invoice_id: string
          line_total: number
          org_id: string
          qty: number
          sort_order: number
          unit: string
          unit_price: number
          vat_rate: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          line_total?: number
          org_id: string
          qty?: number
          sort_order?: number
          unit?: string
          unit_price?: number
          vat_rate?: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          line_total?: number
          org_id?: string
          qty?: number
          sort_order?: number
          unit?: string
          unit_price?: number
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_items_invoice_org_fkey"
            columns: ["invoice_id", "org_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "invoice_line_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_payments: {
        Row: {
          amount: number
          bank_line_id: string | null
          created_at: string
          created_by: string | null
          id: string
          invoice_id: string
          notes: string | null
          org_id: string
          paid_at: string
          reference: string | null
          source: string
          updated_at: string
        }
        Insert: {
          amount: number
          bank_line_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id: string
          notes?: string | null
          org_id: string
          paid_at: string
          reference?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          bank_line_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id?: string
          notes?: string | null
          org_id?: string
          paid_at?: string
          reference?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_payments_bank_line_fkey"
            columns: ["bank_line_id"]
            isOneToOne: false
            referencedRelation: "bank_statement_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_payments_invoice_org_fkey"
            columns: ["invoice_id", "org_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "invoice_payments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_reminders: {
        Row: {
          created_at: string
          email_id: string | null
          id: string
          invoice_id: string
          org_id: string
          recipient: string | null
          sent_at: string
          stage: string
        }
        Insert: {
          created_at?: string
          email_id?: string | null
          id?: string
          invoice_id: string
          org_id: string
          recipient?: string | null
          sent_at?: string
          stage: string
        }
        Update: {
          created_at?: string
          email_id?: string | null
          id?: string
          invoice_id?: string
          org_id?: string
          recipient?: string | null
          sent_at?: string
          stage?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_reminders_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_reminders_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount: number
          created_at: string
          customer_id: string | null
          due_date: string | null
          id: string
          job_id: string | null
          notes: string | null
          number: string
          org_id: string
          paid_at: string | null
          quote_id: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["invoice_status"]
          total: number | null
          updated_at: string
          vat_total: number
        }
        Insert: {
          amount?: number
          created_at?: string
          customer_id?: string | null
          due_date?: string | null
          id?: string
          job_id?: string | null
          notes?: string | null
          number: string
          org_id: string
          paid_at?: string | null
          quote_id?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          total?: number | null
          updated_at?: string
          vat_total?: number
        }
        Update: {
          amount?: number
          created_at?: string
          customer_id?: string | null
          due_date?: string | null
          id?: string
          job_id?: string | null
          notes?: string | null
          number?: string
          org_id?: string
          paid_at?: string | null
          quote_id?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          total?: number | null
          updated_at?: string
          vat_total?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoices_customer_org_fkey"
            columns: ["customer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "invoices_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      job_document_versions: {
        Row: {
          created_at: string
          document_id: string
          filename: string
          form_data: Json | null
          id: string
          mime_type: string
          org_id: string
          size_bytes: number
          storage_bucket: string
          storage_path: string
          uploaded_by: string | null
          version_no: number
          visibility: string
        }
        Insert: {
          created_at?: string
          document_id: string
          filename: string
          form_data?: Json | null
          id?: string
          mime_type: string
          org_id: string
          size_bytes: number
          storage_bucket: string
          storage_path: string
          uploaded_by?: string | null
          version_no: number
          visibility: string
        }
        Update: {
          created_at?: string
          document_id?: string
          filename?: string
          form_data?: Json | null
          id?: string
          mime_type?: string
          org_id?: string
          size_bytes?: number
          storage_bucket?: string
          storage_path?: string
          uploaded_by?: string | null
          version_no?: number
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_document_versions_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "job_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_document_versions_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      job_documents: {
        Row: {
          assigned_to: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string | null
          current_version: string | null
          customer_shared_at: string | null
          doc_type: string
          external_reference: string | null
          id: string
          job_id: string
          org_id: string
          requires_customer_signature: boolean
          requires_staff_signature: boolean
          status: string
          template_id: string | null
          title: string
          updated_at: string
          updated_by: string | null
          visibility: string
        }
        Insert: {
          assigned_to?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          current_version?: string | null
          customer_shared_at?: string | null
          doc_type?: string
          external_reference?: string | null
          id?: string
          job_id: string
          org_id: string
          requires_customer_signature?: boolean
          requires_staff_signature?: boolean
          status?: string
          template_id?: string | null
          title: string
          updated_at?: string
          updated_by?: string | null
          visibility: string
        }
        Update: {
          assigned_to?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          current_version?: string | null
          customer_shared_at?: string | null
          doc_type?: string
          external_reference?: string | null
          id?: string
          job_id?: string
          org_id?: string
          requires_customer_signature?: boolean
          requires_staff_signature?: boolean
          status?: string
          template_id?: string | null
          title?: string
          updated_at?: string
          updated_by?: string | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_documents_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_documents_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_documents_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_documents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_documents_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          ai_summary: string | null
          assigned_to: string | null
          created_at: string
          customer_id: string | null
          id: string
          notes: string | null
          org_id: string
          photos: string[]
          recurring: Json | null
          retention_percent: number
          scheduled_date: string | null
          site_address_line1: string | null
          site_address_line2: string | null
          site_city: string | null
          site_country: string | null
          site_county: string | null
          site_postcode: string | null
          status: string
          updated_at: string
        }
        Insert: {
          ai_summary?: string | null
          assigned_to?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          notes?: string | null
          org_id: string
          photos?: string[]
          recurring?: Json | null
          retention_percent?: number
          scheduled_date?: string | null
          site_address_line1?: string | null
          site_address_line2?: string | null
          site_city?: string | null
          site_country?: string | null
          site_county?: string | null
          site_postcode?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          ai_summary?: string | null
          assigned_to?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          notes?: string | null
          org_id?: string
          photos?: string[]
          recurring?: Json | null
          retention_percent?: number
          scheduled_date?: string | null
          site_address_line1?: string | null
          site_address_line2?: string | null
          site_city?: string | null
          site_country?: string | null
          site_county?: string | null
          site_postcode?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_followup_state: {
        Row: {
          acted_at: string | null
          acted_by: string | null
          acted_kind: string | null
          created_at: string
          lead_id: string
          org_id: string
          reminder_72h_at: string | null
          reminder_7d_at: string | null
          updated_at: string
        }
        Insert: {
          acted_at?: string | null
          acted_by?: string | null
          acted_kind?: string | null
          created_at?: string
          lead_id: string
          org_id: string
          reminder_72h_at?: string | null
          reminder_7d_at?: string | null
          updated_at?: string
        }
        Update: {
          acted_at?: string | null
          acted_by?: string | null
          acted_kind?: string | null
          created_at?: string
          lead_id?: string
          org_id?: string
          reminder_72h_at?: string | null
          reminder_7d_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_followup_state_acted_by_fkey"
            columns: ["acted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_followup_state_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_followup_state_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          ai_summary: string | null
          assigned_to: string | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          customer_id: string | null
          estimated_value: number | null
          first_contact_at: string
          id: string
          last_activity_at: string
          notes: string | null
          org_id: string
          postcode: string | null
          preferred_callback_at: string | null
          property_id: string | null
          service: string | null
          source: string
          status: string
          updated_at: string
          urgency: string | null
        }
        Insert: {
          ai_summary?: string | null
          assigned_to?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          customer_id?: string | null
          estimated_value?: number | null
          first_contact_at?: string
          id?: string
          last_activity_at?: string
          notes?: string | null
          org_id: string
          postcode?: string | null
          preferred_callback_at?: string | null
          property_id?: string | null
          service?: string | null
          source: string
          status?: string
          updated_at?: string
          urgency?: string | null
        }
        Update: {
          ai_summary?: string | null
          assigned_to?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          customer_id?: string | null
          estimated_value?: number | null
          first_contact_at?: string
          id?: string
          last_activity_at?: string
          notes?: string | null
          org_id?: string
          postcode?: string | null
          preferred_callback_at?: string | null
          property_id?: string | null
          service?: string | null
          source?: string
          status?: string
          updated_at?: string
          urgency?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_requests: {
        Row: {
          created_at: string
          ends_at: string
          id: string
          org_id: string
          reason: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          starts_at: string
          status: string
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          ends_at: string
          id?: string
          org_id: string
          reason?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          starts_at: string
          status?: string
          type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          ends_at?: string
          id?: string
          org_id?: string
          reason?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          starts_at?: string
          status?: string
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "leave_requests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          id: string
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string | null
          conversation_id: string
          created_at: string
          direction: string
          from_addr: string | null
          id: string
          media_urls: string[] | null
          org_id: string
          provider_id: string | null
          status: string | null
          to_addr: string | null
        }
        Insert: {
          body?: string | null
          conversation_id: string
          created_at?: string
          direction: string
          from_addr?: string | null
          id?: string
          media_urls?: string[] | null
          org_id: string
          provider_id?: string | null
          status?: string | null
          to_addr?: string | null
        }
        Update: {
          body?: string | null
          conversation_id?: string
          created_at?: string
          direction?: string
          from_addr?: string | null
          id?: string
          media_urls?: string[] | null
          org_id?: string
          provider_id?: string | null
          status?: string | null
          to_addr?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      missed_call_textbacks: {
        Row: {
          call_id: string | null
          caller_number: string
          created_at: string
          id: string
          org_id: string
          sent_at: string | null
          status: string
          template_used: string | null
        }
        Insert: {
          call_id?: string | null
          caller_number: string
          created_at?: string
          id?: string
          org_id: string
          sent_at?: string | null
          status?: string
          template_used?: string | null
        }
        Update: {
          call_id?: string | null
          caller_number?: string
          created_at?: string
          id?: string
          org_id?: string
          sent_at?: string | null
          status?: string
          template_used?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "missed_call_textbacks_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "missed_call_textbacks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_email_queue: {
        Row: {
          body_html: string | null
          body_text: string
          created_at: string
          failed_at: string | null
          id: string
          last_error: string | null
          notification_id: string | null
          org_id: string
          provider: string | null
          provider_message_id: string | null
          reply_to_email: string | null
          retry_count: number
          scheduled_for: string
          sent_at: string | null
          status: string
          subject: string
          to_email: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          body_html?: string | null
          body_text: string
          created_at?: string
          failed_at?: string | null
          id?: string
          last_error?: string | null
          notification_id?: string | null
          org_id: string
          provider?: string | null
          provider_message_id?: string | null
          reply_to_email?: string | null
          retry_count?: number
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          subject: string
          to_email: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          body_html?: string | null
          body_text?: string
          created_at?: string
          failed_at?: string | null
          id?: string
          last_error?: string | null
          notification_id?: string | null
          org_id?: string
          provider?: string | null
          provider_message_id?: string | null
          reply_to_email?: string | null
          retry_count?: number
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          subject?: string
          to_email?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_email_queue_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_email_queue_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_email_queue_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          action_url: string | null
          audience: string
          body: string | null
          category: string
          created_at: string
          dismissed_at: string | null
          id: string
          metadata: Json
          org_id: string
          priority: string
          read_at: string | null
          related_id: string | null
          related_table: string | null
          source_id: string | null
          source_module: string | null
          title: string
          type: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          action_url?: string | null
          audience?: string
          body?: string | null
          category?: string
          created_at?: string
          dismissed_at?: string | null
          id?: string
          metadata?: Json
          org_id: string
          priority?: string
          read_at?: string | null
          related_id?: string | null
          related_table?: string | null
          source_id?: string | null
          source_module?: string | null
          title: string
          type: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          action_url?: string | null
          audience?: string
          body?: string | null
          category?: string
          created_at?: string
          dismissed_at?: string | null
          id?: string
          metadata?: Json
          org_id?: string
          priority?: string
          read_at?: string | null
          related_id?: string | null
          related_table?: string | null
          source_id?: string | null
          source_module?: string | null
          title?: string
          type?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          address: Json | null
          admin_org_notes: string | null
          approved_at: string | null
          approved_by: string | null
          bank_details: Json | null
          billing_email: string | null
          cancelled_at: string | null
          country: string
          created_at: string
          currency: string
          default_terms: string | null
          email: string | null
          health_recomputed_at: string | null
          health_score: number
          id: string
          last_login_at: string | null
          logo_url: string | null
          ltv_gbp: number
          migration_eta: string | null
          migration_percent: number
          migration_stage: string | null
          mrr_gbp: number
          name: string
          next_renewal_at: string | null
          onboarding_owner_id: string | null
          onboarding_percent: number
          onboarding_state: Json
          phone: string | null
          plan: string
          rejection_reason: string | null
          setup_fee_paid_at: string | null
          setup_fee_status: string
          slug: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          suspended_at: string | null
          timezone: string
          trial_ends_at: string | null
          updated_at: string
          vat_number: string | null
        }
        Insert: {
          address?: Json | null
          admin_org_notes?: string | null
          approved_at?: string | null
          approved_by?: string | null
          bank_details?: Json | null
          billing_email?: string | null
          cancelled_at?: string | null
          country?: string
          created_at?: string
          currency?: string
          default_terms?: string | null
          email?: string | null
          health_recomputed_at?: string | null
          health_score?: number
          id?: string
          last_login_at?: string | null
          logo_url?: string | null
          ltv_gbp?: number
          migration_eta?: string | null
          migration_percent?: number
          migration_stage?: string | null
          mrr_gbp?: number
          name: string
          next_renewal_at?: string | null
          onboarding_owner_id?: string | null
          onboarding_percent?: number
          onboarding_state?: Json
          phone?: string | null
          plan?: string
          rejection_reason?: string | null
          setup_fee_paid_at?: string | null
          setup_fee_status?: string
          slug: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          suspended_at?: string | null
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          vat_number?: string | null
        }
        Update: {
          address?: Json | null
          admin_org_notes?: string | null
          approved_at?: string | null
          approved_by?: string | null
          bank_details?: Json | null
          billing_email?: string | null
          cancelled_at?: string | null
          country?: string
          created_at?: string
          currency?: string
          default_terms?: string | null
          email?: string | null
          health_recomputed_at?: string | null
          health_score?: number
          id?: string
          last_login_at?: string | null
          logo_url?: string | null
          ltv_gbp?: number
          migration_eta?: string | null
          migration_percent?: number
          migration_stage?: string | null
          mrr_gbp?: number
          name?: string
          next_renewal_at?: string | null
          onboarding_owner_id?: string | null
          onboarding_percent?: number
          onboarding_state?: Json
          phone?: string | null
          plan?: string
          rejection_reason?: string | null
          setup_fee_paid_at?: string | null
          setup_fee_status?: string
          slug?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          suspended_at?: string | null
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          vat_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organizations_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_onboarding_owner_id_fkey"
            columns: ["onboarding_owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_lines: {
        Row: {
          created_at: string
          gross_pay: number
          hourly_pay: number
          hours: number
          id: string
          net_pay: number
          ni_estimate: number
          note: string | null
          org_id: string
          paye_estimate: number
          payroll_run_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          gross_pay?: number
          hourly_pay?: number
          hours?: number
          id?: string
          net_pay?: number
          ni_estimate?: number
          note?: string | null
          org_id: string
          paye_estimate?: number
          payroll_run_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          gross_pay?: number
          hourly_pay?: number
          hours?: number
          id?: string
          net_pay?: number
          ni_estimate?: number
          note?: string | null
          org_id?: string
          paye_estimate?: number
          payroll_run_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payroll_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_lines_payroll_run_id_fkey"
            columns: ["payroll_run_id"]
            isOneToOne: false
            referencedRelation: "payroll_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_lines_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_runs: {
        Row: {
          created_at: string
          created_by: string | null
          cycle: string
          finalised_at: string | null
          id: string
          org_id: string
          period_end: string
          period_start: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          cycle: string
          finalised_at?: string | null
          id?: string
          org_id: string
          period_end: string
          period_start: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          cycle?: string
          finalised_at?: string | null
          id?: string
          org_id?: string
          period_end?: string
          period_start?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payroll_runs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_uploads: {
        Row: {
          customer_id: string
          filename: string
          id: string
          kind: string
          mime_type: string | null
          notes: string | null
          org_id: string
          size_bytes: number | null
          storage_path: string
          target_id: string
          target_table: string
          uploaded_at: string
        }
        Insert: {
          customer_id: string
          filename: string
          id?: string
          kind: string
          mime_type?: string | null
          notes?: string | null
          org_id: string
          size_bytes?: number | null
          storage_path: string
          target_id: string
          target_table: string
          uploaded_at?: string
        }
        Update: {
          customer_id?: string
          filename?: string
          id?: string
          kind?: string
          mime_type?: string | null
          notes?: string | null
          org_id?: string
          size_bytes?: number | null
          storage_path?: string
          target_id?: string
          target_table?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "portal_uploads_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_uploads_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      properties: {
        Row: {
          address: Json
          created_at: string
          customer_id: string
          id: string
          notes: string | null
          org_id: string
        }
        Insert: {
          address: Json
          created_at?: string
          customer_id: string
          id?: string
          notes?: string | null
          org_id: string
        }
        Update: {
          address?: Json
          created_at?: string
          customer_id?: string
          id?: string
          notes?: string | null
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "properties_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_line_items: {
        Row: {
          created_at: string
          description: string
          id: string
          line_total: number
          org_id: string
          purchase_order_id: string
          qty: number
          sort_order: number
          unit: string | null
          unit_price: number
          vat_rate: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          line_total?: number
          org_id: string
          purchase_order_id: string
          qty?: number
          sort_order?: number
          unit?: string | null
          unit_price?: number
          vat_rate?: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          line_total?: number
          org_id?: string
          purchase_order_id?: string
          qty?: number
          sort_order?: number
          unit?: string | null
          unit_price?: number
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_line_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_line_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          created_at: string
          created_by: string | null
          expected_date: string | null
          id: string
          job_id: string | null
          notes: string | null
          number: string
          org_id: string
          status: string
          subtotal: number
          supplier_id: string | null
          supplier_reference: string | null
          total: number | null
          updated_at: string
          vat_total: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expected_date?: string | null
          id?: string
          job_id?: string | null
          notes?: string | null
          number: string
          org_id: string
          status?: string
          subtotal?: number
          supplier_id?: string | null
          supplier_reference?: string | null
          total?: number | null
          updated_at?: string
          vat_total?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expected_date?: string | null
          id?: string
          job_id?: string | null
          notes?: string | null
          number?: string
          org_id?: string
          status?: string
          subtotal?: number
          supplier_id?: string | null
          supplier_reference?: string | null
          total?: number | null
          updated_at?: string
          vat_total?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_line_items: {
        Row: {
          description: string
          id: string
          line_total: number
          org_id: string
          qty: number
          quote_id: string
          sort_order: number
          unit: string
          unit_price: number
          vat_rate: number
        }
        Insert: {
          description: string
          id?: string
          line_total?: number
          org_id: string
          qty?: number
          quote_id: string
          sort_order?: number
          unit?: string
          unit_price?: number
          vat_rate?: number
        }
        Update: {
          description?: string
          id?: string
          line_total?: number
          org_id?: string
          qty?: number
          quote_id?: string
          sort_order?: number
          unit?: string
          unit_price?: number
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_line_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_line_items_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          accept_signature: Json | null
          accepted_at: string | null
          approval_comment: string | null
          approved_at: string | null
          approved_by: string | null
          created_at: string
          created_by: string | null
          currency: string
          customer_comment: string | null
          customer_id: string
          declined_at: string | null
          followup_sent_at: string | null
          id: string
          job_id: string | null
          lead_id: string | null
          notes: string | null
          number: string
          org_id: string
          property_id: string | null
          public_token: string
          sent_at: string | null
          status: string
          subtotal: number
          terms: string | null
          total: number
          updated_at: string
          valid_until: string | null
          variation_number: number | null
          vat_total: number
          viewed_at: string | null
        }
        Insert: {
          accept_signature?: Json | null
          accepted_at?: string | null
          approval_comment?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_comment?: string | null
          customer_id: string
          declined_at?: string | null
          followup_sent_at?: string | null
          id?: string
          job_id?: string | null
          lead_id?: string | null
          notes?: string | null
          number: string
          org_id: string
          property_id?: string | null
          public_token?: string
          sent_at?: string | null
          status?: string
          subtotal?: number
          terms?: string | null
          total?: number
          updated_at?: string
          valid_until?: string | null
          variation_number?: number | null
          vat_total?: number
          viewed_at?: string | null
        }
        Update: {
          accept_signature?: Json | null
          accepted_at?: string | null
          approval_comment?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_comment?: string | null
          customer_id?: string
          declined_at?: string | null
          followup_sent_at?: string | null
          id?: string
          job_id?: string | null
          lead_id?: string | null
          notes?: string | null
          number?: string
          org_id?: string
          property_id?: string | null
          public_token?: string
          sent_at?: string | null
          status?: string
          subtotal?: number
          terms?: string | null
          total?: number
          updated_at?: string
          valid_until?: string | null
          variation_number?: number | null
          vat_total?: number
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotes_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_counters: {
        Row: {
          count: number
          key: string
          reset_at: string
          window_start: string
        }
        Insert: {
          count?: number
          key: string
          reset_at: string
          window_start?: string
        }
        Update: {
          count?: number
          key?: string
          reset_at?: string
          window_start?: string
        }
        Relationships: []
      }
      receptionist_conversation_actions: {
        Row: {
          action_type: string
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          enquiry_id: string | null
          id: string
          job_type: string | null
          lead_id: string | null
          metadata: Json
          org_id: string
          phone_number: string | null
          postcode: string | null
          status: string
        }
        Insert: {
          action_type: string
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id: string
          phone_number?: string | null
          postcode?: string | null
          status?: string
        }
        Update: {
          action_type?: string
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id?: string
          phone_number?: string | null
          postcode?: string | null
          status?: string
        }
        Relationships: []
      }
      receptionist_conversation_authorisations: {
        Row: {
          action_id: string | null
          authorisation_state: string
          authorisation_type: string
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          enquiry_id: string | null
          execution_eligibility: string
          execution_id: string | null
          id: string
          job_type: string | null
          lead_id: string | null
          metadata: Json
          org_id: string
          phone_number: string | null
          postcode: string | null
          requirement: string
          review_audit_id: string | null
          status: string
        }
        Insert: {
          action_id?: string | null
          authorisation_state: string
          authorisation_type: string
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_eligibility: string
          execution_id?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id: string
          phone_number?: string | null
          postcode?: string | null
          requirement: string
          review_audit_id?: string | null
          status?: string
        }
        Update: {
          action_id?: string | null
          authorisation_state?: string
          authorisation_type?: string
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_eligibility?: string
          execution_id?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id?: string
          phone_number?: string | null
          postcode?: string | null
          requirement?: string
          review_audit_id?: string | null
          status?: string
        }
        Relationships: []
      }
      receptionist_conversation_claim_reassignments: {
        Row: {
          claim_id: string
          conversation_id: string | null
          coordination_id: string
          correlation_id: string | null
          created_at: string
          from_operator_email: string | null
          from_operator_id: string
          id: string
          metadata: Json
          org_id: string
          reassigned_at: string
          reassignment_outcome: string
          reassignment_type: string
          request_id: string
          status: string
          to_operator_email: string | null
          to_operator_id: string
        }
        Insert: {
          claim_id: string
          conversation_id?: string | null
          coordination_id: string
          correlation_id?: string | null
          created_at?: string
          from_operator_email?: string | null
          from_operator_id: string
          id?: string
          metadata?: Json
          org_id: string
          reassigned_at?: string
          reassignment_outcome: string
          reassignment_type: string
          request_id: string
          status?: string
          to_operator_email?: string | null
          to_operator_id: string
        }
        Update: {
          claim_id?: string
          conversation_id?: string | null
          coordination_id?: string
          correlation_id?: string | null
          created_at?: string
          from_operator_email?: string | null
          from_operator_id?: string
          id?: string
          metadata?: Json
          org_id?: string
          reassigned_at?: string
          reassignment_outcome?: string
          reassignment_type?: string
          request_id?: string
          status?: string
          to_operator_email?: string | null
          to_operator_id?: string
        }
        Relationships: []
      }
      receptionist_conversation_claim_releases: {
        Row: {
          claim_id: string
          conversation_id: string | null
          coordination_id: string
          correlation_id: string | null
          created_at: string
          id: string
          metadata: Json
          operator_email: string | null
          operator_id: string
          org_id: string
          release_outcome: string
          release_type: string
          released_at: string
          status: string
        }
        Insert: {
          claim_id: string
          conversation_id?: string | null
          coordination_id: string
          correlation_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          operator_email?: string | null
          operator_id: string
          org_id: string
          release_outcome: string
          release_type: string
          released_at?: string
          status?: string
        }
        Update: {
          claim_id?: string
          conversation_id?: string | null
          coordination_id?: string
          correlation_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          operator_email?: string | null
          operator_id?: string
          org_id?: string
          release_outcome?: string
          release_type?: string
          released_at?: string
          status?: string
        }
        Relationships: []
      }
      receptionist_conversation_claims: {
        Row: {
          claim_outcome: string
          claim_type: string
          claimed_at: string
          conversation_id: string | null
          coordination_id: string
          correlation_id: string | null
          created_at: string
          id: string
          metadata: Json
          operator_email: string | null
          operator_id: string
          org_id: string
          status: string
        }
        Insert: {
          claim_outcome: string
          claim_type: string
          claimed_at?: string
          conversation_id?: string | null
          coordination_id: string
          correlation_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          operator_email?: string | null
          operator_id: string
          org_id: string
          status?: string
        }
        Update: {
          claim_outcome?: string
          claim_type?: string
          claimed_at?: string
          conversation_id?: string | null
          coordination_id?: string
          correlation_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          operator_email?: string | null
          operator_id?: string
          org_id?: string
          status?: string
        }
        Relationships: []
      }
      receptionist_conversation_coordinations: {
        Row: {
          action_id: string | null
          approval_state: string
          authorisation_id: string
          autonomous: boolean
          conversation_id: string | null
          coordination_mode: string
          coordination_outcome: string
          coordination_type: string
          correlation_id: string
          created_at: string
          customer_ref: string | null
          enquiry_id: string | null
          execution_id: string | null
          fulfilment_id: string | null
          id: string
          job_type: string | null
          lead_id: string | null
          lead_participant: string
          lifecycle_id: string
          lifecycle_state: string
          metadata: Json
          orchestration_id: string
          orchestration_route: string
          org_id: string
          participant_count: number
          phone_number: string | null
          postcode: string | null
          recovery_id: string
          requires_human: boolean
          resolution_id: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status: string
          verification_id: string
        }
        Insert: {
          action_id?: string | null
          approval_state: string
          authorisation_id: string
          autonomous: boolean
          conversation_id?: string | null
          coordination_mode: string
          coordination_outcome: string
          coordination_type: string
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          lead_participant: string
          lifecycle_id: string
          lifecycle_state: string
          metadata?: Json
          orchestration_id: string
          orchestration_route: string
          org_id: string
          participant_count: number
          phone_number?: string | null
          postcode?: string | null
          recovery_id: string
          requires_human: boolean
          resolution_id: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status?: string
          verification_id: string
        }
        Update: {
          action_id?: string | null
          approval_state?: string
          authorisation_id?: string
          autonomous?: boolean
          conversation_id?: string | null
          coordination_mode?: string
          coordination_outcome?: string
          coordination_type?: string
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          lead_participant?: string
          lifecycle_id?: string
          lifecycle_state?: string
          metadata?: Json
          orchestration_id?: string
          orchestration_route?: string
          org_id?: string
          participant_count?: number
          phone_number?: string | null
          postcode?: string | null
          recovery_id?: string
          requires_human?: boolean
          resolution_id?: string
          review_audit_id?: string
          review_resolution_id?: string
          sent_audit_id?: string
          status?: string
          verification_id?: string
        }
        Relationships: []
      }
      receptionist_conversation_executions: {
        Row: {
          action_id: string | null
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          eligibility: string
          enquiry_id: string | null
          execution_type: string
          id: string
          job_type: string | null
          lead_id: string | null
          live_execution: boolean
          metadata: Json
          org_id: string
          phone_number: string | null
          policy_verdict: string
          postcode: string | null
          status: string
        }
        Insert: {
          action_id?: string | null
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          eligibility: string
          enquiry_id?: string | null
          execution_type: string
          id?: string
          job_type?: string | null
          lead_id?: string | null
          live_execution: boolean
          metadata?: Json
          org_id: string
          phone_number?: string | null
          policy_verdict: string
          postcode?: string | null
          status?: string
        }
        Update: {
          action_id?: string | null
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          eligibility?: string
          enquiry_id?: string | null
          execution_type?: string
          id?: string
          job_type?: string | null
          lead_id?: string | null
          live_execution?: boolean
          metadata?: Json
          org_id?: string
          phone_number?: string | null
          policy_verdict?: string
          postcode?: string | null
          status?: string
        }
        Relationships: []
      }
      receptionist_conversation_fulfilments: {
        Row: {
          action_id: string | null
          approval_state: string
          authorisation_id: string
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          enquiry_id: string | null
          execution_id: string | null
          fulfilment_outcome: string
          fulfilment_type: string
          id: string
          job_type: string | null
          lead_id: string | null
          metadata: Json
          org_id: string
          phone_number: string | null
          postcode: string | null
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status: string
        }
        Insert: {
          action_id?: string | null
          approval_state: string
          authorisation_id: string
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_outcome: string
          fulfilment_type: string
          id?: string
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id: string
          phone_number?: string | null
          postcode?: string | null
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status?: string
        }
        Update: {
          action_id?: string | null
          approval_state?: string
          authorisation_id?: string
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_outcome?: string
          fulfilment_type?: string
          id?: string
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id?: string
          phone_number?: string | null
          postcode?: string | null
          review_audit_id?: string
          review_resolution_id?: string
          sent_audit_id?: string
          status?: string
        }
        Relationships: []
      }
      receptionist_conversation_lifecycles: {
        Row: {
          action_id: string | null
          approval_state: string
          authorisation_id: string
          closed: boolean
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          enquiry_id: string | null
          execution_id: string | null
          fulfilment_id: string | null
          id: string
          job_type: string | null
          lead_id: string | null
          lifecycle_outcome: string
          lifecycle_state: string
          lifecycle_transition: string
          lifecycle_type: string
          metadata: Json
          ongoing: boolean
          org_id: string
          phone_number: string | null
          postcode: string | null
          recovery_id: string
          resolution_id: string
          resolution_state: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status: string
          verification_id: string
        }
        Insert: {
          action_id?: string | null
          approval_state: string
          authorisation_id: string
          closed: boolean
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          lifecycle_outcome: string
          lifecycle_state: string
          lifecycle_transition: string
          lifecycle_type: string
          metadata?: Json
          ongoing: boolean
          org_id: string
          phone_number?: string | null
          postcode?: string | null
          recovery_id: string
          resolution_id: string
          resolution_state: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status?: string
          verification_id: string
        }
        Update: {
          action_id?: string | null
          approval_state?: string
          authorisation_id?: string
          closed?: boolean
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          lifecycle_outcome?: string
          lifecycle_state?: string
          lifecycle_transition?: string
          lifecycle_type?: string
          metadata?: Json
          ongoing?: boolean
          org_id?: string
          phone_number?: string | null
          postcode?: string | null
          recovery_id?: string
          resolution_id?: string
          resolution_state?: string
          review_audit_id?: string
          review_resolution_id?: string
          sent_audit_id?: string
          status?: string
          verification_id?: string
        }
        Relationships: []
      }
      receptionist_conversation_orchestrations: {
        Row: {
          action_id: string | null
          active: boolean
          approval_state: string
          authorisation_id: string
          concluded: boolean
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          enquiry_id: string | null
          execution_id: string | null
          fulfilment_id: string | null
          id: string
          job_type: string | null
          lead_id: string | null
          lifecycle_id: string
          lifecycle_state: string
          metadata: Json
          orchestration_outcome: string
          orchestration_route: string
          orchestration_target: string
          orchestration_type: string
          org_id: string
          phone_number: string | null
          postcode: string | null
          recovery_id: string
          resolution_id: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status: string
          verification_id: string
        }
        Insert: {
          action_id?: string | null
          active: boolean
          approval_state: string
          authorisation_id: string
          concluded: boolean
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          lifecycle_id: string
          lifecycle_state: string
          metadata?: Json
          orchestration_outcome: string
          orchestration_route: string
          orchestration_target: string
          orchestration_type: string
          org_id: string
          phone_number?: string | null
          postcode?: string | null
          recovery_id: string
          resolution_id: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status?: string
          verification_id: string
        }
        Update: {
          action_id?: string | null
          active?: boolean
          approval_state?: string
          authorisation_id?: string
          concluded?: boolean
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          job_type?: string | null
          lead_id?: string | null
          lifecycle_id?: string
          lifecycle_state?: string
          metadata?: Json
          orchestration_outcome?: string
          orchestration_route?: string
          orchestration_target?: string
          orchestration_type?: string
          org_id?: string
          phone_number?: string | null
          postcode?: string | null
          recovery_id?: string
          resolution_id?: string
          review_audit_id?: string
          review_resolution_id?: string
          sent_audit_id?: string
          status?: string
          verification_id?: string
        }
        Relationships: []
      }
      receptionist_conversation_outcomes: {
        Row: {
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          enquiry_id: string | null
          id: string
          lead_id: string | null
          metadata: Json
          org_id: string
          outcome_type: string
          phone_number: string | null
          status: string
        }
        Insert: {
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          id?: string
          lead_id?: string | null
          metadata?: Json
          org_id: string
          outcome_type: string
          phone_number?: string | null
          status?: string
        }
        Update: {
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          id?: string
          lead_id?: string | null
          metadata?: Json
          org_id?: string
          outcome_type?: string
          phone_number?: string | null
          status?: string
        }
        Relationships: []
      }
      receptionist_conversation_recoveries: {
        Row: {
          action_id: string | null
          approval_state: string
          authorisation_id: string
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          enquiry_id: string | null
          execution_id: string | null
          fulfilment_id: string | null
          id: string
          integrity: string
          job_type: string | null
          lead_id: string | null
          metadata: Json
          org_id: string
          phone_number: string | null
          postcode: string | null
          recovery_classification: string
          recovery_outcome: string
          recovery_required: boolean
          recovery_type: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status: string
          verification_id: string
        }
        Insert: {
          action_id?: string | null
          approval_state: string
          authorisation_id: string
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          integrity: string
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id: string
          phone_number?: string | null
          postcode?: string | null
          recovery_classification: string
          recovery_outcome: string
          recovery_required: boolean
          recovery_type: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status?: string
          verification_id: string
        }
        Update: {
          action_id?: string | null
          approval_state?: string
          authorisation_id?: string
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          integrity?: string
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id?: string
          phone_number?: string | null
          postcode?: string | null
          recovery_classification?: string
          recovery_outcome?: string
          recovery_required?: boolean
          recovery_type?: string
          review_audit_id?: string
          review_resolution_id?: string
          sent_audit_id?: string
          status?: string
          verification_id?: string
        }
        Relationships: []
      }
      receptionist_conversation_resolutions: {
        Row: {
          action_id: string | null
          approval_state: string
          authorisation_id: string
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          enquiry_id: string | null
          execution_id: string | null
          fulfilment_id: string | null
          id: string
          intervention_required: boolean
          job_type: string | null
          lead_id: string | null
          metadata: Json
          org_id: string
          phone_number: string | null
          postcode: string | null
          recovery_classification: string
          recovery_id: string
          resolution_outcome: string
          resolution_state: string
          resolution_type: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status: string
          terminal: boolean
          verification_id: string
        }
        Insert: {
          action_id?: string | null
          approval_state: string
          authorisation_id: string
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          intervention_required: boolean
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id: string
          phone_number?: string | null
          postcode?: string | null
          recovery_classification: string
          recovery_id: string
          resolution_outcome: string
          resolution_state: string
          resolution_type: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status?: string
          terminal: boolean
          verification_id: string
        }
        Update: {
          action_id?: string | null
          approval_state?: string
          authorisation_id?: string
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          intervention_required?: boolean
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id?: string
          phone_number?: string | null
          postcode?: string | null
          recovery_classification?: string
          recovery_id?: string
          resolution_outcome?: string
          resolution_state?: string
          resolution_type?: string
          review_audit_id?: string
          review_resolution_id?: string
          sent_audit_id?: string
          status?: string
          terminal?: boolean
          verification_id?: string
        }
        Relationships: []
      }
      receptionist_conversation_verifications: {
        Row: {
          action_id: string | null
          approval_state: string
          authorisation_id: string
          conversation_id: string | null
          correlation_id: string
          created_at: string
          customer_ref: string | null
          enquiry_id: string | null
          execution_id: string | null
          fulfilment_id: string | null
          id: string
          integrity: string
          job_type: string | null
          lead_id: string | null
          metadata: Json
          org_id: string
          phone_number: string | null
          postcode: string | null
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status: string
          verification_outcome: string
          verification_type: string
        }
        Insert: {
          action_id?: string | null
          approval_state: string
          authorisation_id: string
          conversation_id?: string | null
          correlation_id: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          integrity: string
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id: string
          phone_number?: string | null
          postcode?: string | null
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          status?: string
          verification_outcome: string
          verification_type: string
        }
        Update: {
          action_id?: string | null
          approval_state?: string
          authorisation_id?: string
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          customer_ref?: string | null
          enquiry_id?: string | null
          execution_id?: string | null
          fulfilment_id?: string | null
          id?: string
          integrity?: string
          job_type?: string | null
          lead_id?: string | null
          metadata?: Json
          org_id?: string
          phone_number?: string | null
          postcode?: string | null
          review_audit_id?: string
          review_resolution_id?: string
          sent_audit_id?: string
          status?: string
          verification_outcome?: string
          verification_type?: string
        }
        Relationships: []
      }
      receptionist_conversations: {
        Row: {
          assigned_at: string | null
          assigned_by: string | null
          assignee_id: string | null
          channel: string
          contact_name: string | null
          contact_ref: string
          created_at: string
          employee_slug: string
          first_message_at: string
          goal: string
          id: string
          information: Json
          intent: string
          last_message_at: string
          message_count: number
          org_id: string
          runtime_state: string
          status: string
          updated_at: string
        }
        Insert: {
          assigned_at?: string | null
          assigned_by?: string | null
          assignee_id?: string | null
          channel: string
          contact_name?: string | null
          contact_ref: string
          created_at?: string
          employee_slug: string
          first_message_at?: string
          goal?: string
          id?: string
          information?: Json
          intent?: string
          last_message_at?: string
          message_count?: number
          org_id: string
          runtime_state?: string
          status?: string
          updated_at?: string
        }
        Update: {
          assigned_at?: string | null
          assigned_by?: string | null
          assignee_id?: string | null
          channel?: string
          contact_name?: string | null
          contact_ref?: string
          created_at?: string
          employee_slug?: string
          first_message_at?: string
          goal?: string
          id?: string
          information?: Json
          intent?: string
          last_message_at?: string
          message_count?: number
          org_id?: string
          runtime_state?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "receptionist_conversations_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receptionist_conversations_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receptionist_conversations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      receptionist_messages: {
        Row: {
          audit_id: string | null
          channel: string
          conversation_id: string
          created_at: string
          direction: string
          enquiry_id: string | null
          id: string
          org_id: string
        }
        Insert: {
          audit_id?: string | null
          channel: string
          conversation_id: string
          created_at?: string
          direction: string
          enquiry_id?: string | null
          id?: string
          org_id: string
        }
        Update: {
          audit_id?: string | null
          channel?: string
          conversation_id?: string
          created_at?: string
          direction?: string
          enquiry_id?: string | null
          id?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "receptionist_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "receptionist_conversation_list"
            referencedColumns: ["conversation_id"]
          },
          {
            foreignKeyName: "receptionist_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "receptionist_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receptionist_messages_enquiry_id_fkey"
            columns: ["enquiry_id"]
            isOneToOne: false
            referencedRelation: "inbound_enquiries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receptionist_messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      receptionist_review_resolutions: {
        Row: {
          conversation_id: string | null
          created_at: string
          edited: boolean
          id: string
          note: string | null
          org_id: string
          resolution: string
          resolved_by: string
          resolved_by_email: string | null
          review_audit_id: string
          sent_audit_id: string | null
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          edited?: boolean
          id?: string
          note?: string | null
          org_id: string
          resolution: string
          resolved_by: string
          resolved_by_email?: string | null
          review_audit_id: string
          sent_audit_id?: string | null
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          edited?: boolean
          id?: string
          note?: string | null
          org_id?: string
          resolution?: string
          resolved_by?: string
          resolved_by_email?: string | null
          review_audit_id?: string
          sent_audit_id?: string | null
        }
        Relationships: []
      }
      retention_releases: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          id: string
          job_id: string
          note: string | null
          org_id: string
          released_on: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          id?: string
          job_id: string
          note?: string | null
          org_id: string
          released_on?: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string
          note?: string | null
          org_id?: string
          released_on?: string
        }
        Relationships: [
          {
            foreignKeyName: "retention_releases_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retention_releases_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      review_requests: {
        Row: {
          completed_at: string | null
          created_at: string
          customer_id: string | null
          delay_days: number
          id: string
          job_id: string | null
          notes: string | null
          org_id: string
          platform: string
          requested_by: string | null
          send_at: string
          sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          customer_id?: string | null
          delay_days?: number
          id?: string
          job_id?: string | null
          notes?: string | null
          org_id: string
          platform: string
          requested_by?: string | null
          send_at: string
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          customer_id?: string | null
          delay_days?: number
          id?: string
          job_id?: string | null
          notes?: string | null
          org_id?: string
          platform?: string
          requested_by?: string | null
          send_at?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_requests_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_requests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      rota_entries: {
        Row: {
          created_at: string
          created_by: string | null
          ends_at: string
          id: string
          job_id: string | null
          notes: string | null
          org_id: string
          starts_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          ends_at: string
          id?: string
          job_id?: string | null
          notes?: string | null
          org_id: string
          starts_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          ends_at?: string
          id?: string
          job_id?: string | null
          notes?: string | null
          org_id?: string
          starts_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rota_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rota_entries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rota_entries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rota_entries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      service_catalog: {
        Row: {
          created_at: string
          default_price: number | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          org_id: string
          sort_order: number
          unit: string
          vat_rate: number
        }
        Insert: {
          created_at?: string
          default_price?: number | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          org_id: string
          sort_order?: number
          unit?: string
          vat_rate?: number
        }
        Update: {
          created_at?: string
          default_price?: number | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          org_id?: string
          sort_order?: number
          unit?: string
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "service_catalog_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      signatures: {
        Row: {
          created_at: string
          id: string
          ip_address: string | null
          org_id: string
          signature_text: string | null
          signed_at: string
          signer_email: string | null
          signer_name: string
          target_id: string
          target_table: string
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          ip_address?: string | null
          org_id: string
          signature_text?: string | null
          signed_at?: string
          signer_email?: string | null
          signer_name: string
          target_id: string
          target_table: string
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          ip_address?: string | null
          org_id?: string
          signature_text?: string | null
          signed_at?: string
          signer_email?: string | null
          signer_name?: string
          target_id?: string
          target_table?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signatures_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      site_diary_entries: {
        Row: {
          created_at: string
          created_by: string | null
          delays: string | null
          entry_date: string
          id: string
          job_id: string | null
          labour_count: number | null
          notes: string | null
          org_id: string
          updated_at: string
          weather: string | null
          work_summary: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          delays?: string | null
          entry_date?: string
          id?: string
          job_id?: string | null
          labour_count?: number | null
          notes?: string | null
          org_id: string
          updated_at?: string
          weather?: string | null
          work_summary?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          delays?: string | null
          entry_date?: string
          id?: string
          job_id?: string | null
          labour_count?: number | null
          notes?: string | null
          org_id?: string
          updated_at?: string
          weather?: string | null
          work_summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "site_diary_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_diary_entries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_diary_entries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      site_reports: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          content: Json
          created_at: string
          customer_id: string | null
          customer_notified_at: string | null
          id: string
          issued_at: string | null
          job_id: string | null
          org_id: string
          period_end: string
          period_start: string
          portal_published_at: string | null
          portal_published_by: string | null
          portal_withdrawn_at: string | null
          prepared_by: string | null
          report_number: string | null
          reviewed_by: string | null
          revision: number
          snapshot: Json | null
          status: string
          supersedes_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          content?: Json
          created_at?: string
          customer_id?: string | null
          customer_notified_at?: string | null
          id?: string
          issued_at?: string | null
          job_id?: string | null
          org_id: string
          period_end: string
          period_start: string
          portal_published_at?: string | null
          portal_published_by?: string | null
          portal_withdrawn_at?: string | null
          prepared_by?: string | null
          report_number?: string | null
          reviewed_by?: string | null
          revision?: number
          snapshot?: Json | null
          status?: string
          supersedes_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          content?: Json
          created_at?: string
          customer_id?: string | null
          customer_notified_at?: string | null
          id?: string
          issued_at?: string | null
          job_id?: string | null
          org_id?: string
          period_end?: string
          period_start?: string
          portal_published_at?: string | null
          portal_published_by?: string | null
          portal_withdrawn_at?: string | null
          prepared_by?: string | null
          report_number?: string | null
          reviewed_by?: string | null
          revision?: number
          snapshot?: Json | null
          status?: string
          supersedes_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "site_reports_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_reports_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_reports_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_reports_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_reports_portal_published_by_fkey"
            columns: ["portal_published_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_reports_prepared_by_fkey"
            columns: ["prepared_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_reports_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "site_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      snags: {
        Row: {
          assigned_to: string | null
          created_at: string
          description: string | null
          due_date: string | null
          id: string
          job_id: string | null
          location: string | null
          org_id: string
          priority: string
          reported_by: string | null
          resolved_at: string | null
          status: string
          title: string
          trade: string | null
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          job_id?: string | null
          location?: string | null
          org_id: string
          priority?: string
          reported_by?: string | null
          resolved_at?: string | null
          status?: string
          title: string
          trade?: string | null
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          job_id?: string | null
          location?: string | null
          org_id?: string
          priority?: string
          reported_by?: string | null
          resolved_at?: string | null
          status?: string
          title?: string
          trade?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "snags_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snags_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snags_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snags_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_secrets: {
        Row: {
          ni_number: string | null
          org_id: string
          updated_at: string
          updated_by: string | null
          user_id: string
        }
        Insert: {
          ni_number?: string | null
          org_id: string
          updated_at?: string
          updated_by?: string | null
          user_id: string
        }
        Update: {
          ni_number?: string | null
          org_id?: string
          updated_at?: string
          updated_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_secrets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_secrets_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_secrets_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          category: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          org_id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          org_id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          org_id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      support_messages: {
        Row: {
          author_id: string | null
          author_kind: string
          body: string
          created_at: string
          id: string
          internal: boolean
          org_id: string
          ticket_id: string
        }
        Insert: {
          author_id?: string | null
          author_kind: string
          body: string
          created_at?: string
          id?: string
          internal?: boolean
          org_id: string
          ticket_id: string
        }
        Update: {
          author_id?: string | null
          author_kind?: string
          body?: string
          created_at?: string
          id?: string
          internal?: boolean
          org_id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_messages_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_messages_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      support_tickets: {
        Row: {
          assigned_to: string | null
          category: string
          closed_at: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          id: string
          last_reply_at: string | null
          last_reply_kind: string | null
          org_id: string
          priority: string
          resolved_at: string | null
          status: string
          subject: string
          ticket_number: number
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          category?: string
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          last_reply_at?: string | null
          last_reply_kind?: string | null
          org_id: string
          priority?: string
          resolved_at?: string | null
          status?: string
          subject: string
          ticket_number: number
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          category?: string
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          last_reply_at?: string | null
          last_reply_kind?: string | null
          org_id?: string
          priority?: string
          resolved_at?: string | null
          status?: string
          subject?: string
          ticket_number?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_tickets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_attachments: {
        Row: {
          created_at: string
          filename: string
          id: string
          mime_type: string | null
          org_id: string
          size_bytes: number | null
          storage_path: string
          target_id: string
          target_table: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          filename: string
          id?: string
          mime_type?: string | null
          org_id: string
          size_bytes?: number | null
          storage_path: string
          target_id: string
          target_table: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          filename?: string
          id?: string
          mime_type?: string | null
          org_id?: string
          size_bytes?: number | null
          storage_path?: string
          target_id?: string
          target_table?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_attachments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      time_entries: {
        Row: {
          breaks: Json
          created_at: string
          ended_at: string | null
          gps_lat: number | null
          gps_lng: number | null
          id: string
          job_id: string | null
          note: string | null
          org_id: string
          payroll_line_id: string | null
          started_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          breaks?: Json
          created_at?: string
          ended_at?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          job_id?: string | null
          note?: string | null
          org_id: string
          payroll_line_id?: string | null
          started_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          breaks?: Json
          created_at?: string
          ended_at?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          job_id?: string | null
          note?: string | null
          org_id?: string
          payroll_line_id?: string | null
          started_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_entries_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_payroll_line_id_fkey"
            columns: ["payroll_line_id"]
            isOneToOne: false
            referencedRelation: "payroll_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      toolbox_talks: {
        Row: {
          attendee_count: number | null
          attendees: string | null
          created_at: string
          created_by: string | null
          id: string
          job_id: string | null
          notes: string | null
          org_id: string
          presenter: string | null
          talk_date: string
          topic: string
          updated_at: string
        }
        Insert: {
          attendee_count?: number | null
          attendees?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string | null
          notes?: string | null
          org_id: string
          presenter?: string | null
          talk_date?: string
          topic: string
          updated_at?: string
        }
        Update: {
          attendee_count?: number | null
          attendees?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string | null
          notes?: string | null
          org_id?: string
          presenter?: string | null
          talk_date?: string
          topic?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "toolbox_talks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "toolbox_talks_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "toolbox_talks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          emergency_contact: Json | null
          employment_type: string | null
          full_name: string | null
          hourly_pay: number | null
          id: string
          phone: string | null
          start_date: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          emergency_contact?: Json | null
          employment_type?: string | null
          full_name?: string | null
          hourly_pay?: number | null
          id: string
          phone?: string | null
          start_date?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          emergency_contact?: Json | null
          employment_type?: string | null
          full_name?: string | null
          hourly_pay?: number | null
          id?: string
          phone?: string | null
          start_date?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      voice_notes: {
        Row: {
          actioned_at: string | null
          ai_extracted: Json | null
          ai_summary: string | null
          audio_url: string
          created_at: string
          duration_sec: number | null
          id: string
          intent: string | null
          intent_confidence: number | null
          org_id: string
          recorded_by: string | null
          status: string
          target_id: string | null
          target_type: string | null
          transcript: string | null
          transcript_confidence: number | null
        }
        Insert: {
          actioned_at?: string | null
          ai_extracted?: Json | null
          ai_summary?: string | null
          audio_url: string
          created_at?: string
          duration_sec?: number | null
          id?: string
          intent?: string | null
          intent_confidence?: number | null
          org_id: string
          recorded_by?: string | null
          status?: string
          target_id?: string | null
          target_type?: string | null
          transcript?: string | null
          transcript_confidence?: number | null
        }
        Update: {
          actioned_at?: string | null
          ai_extracted?: Json | null
          ai_summary?: string | null
          audio_url?: string
          created_at?: string
          duration_sec?: number | null
          id?: string
          intent?: string | null
          intent_confidence?: number | null
          org_id?: string
          recorded_by?: string | null
          status?: string
          target_id?: string | null
          target_type?: string | null
          transcript?: string | null
          transcript_confidence?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "voice_notes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_notes_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist: {
        Row: {
          company_name: string | null
          created_at: string
          email: string
          employees: string | null
          id: string
          ip_hash: string | null
          phone: string | null
          source: string | null
          trade: string | null
          user_agent: string | null
        }
        Insert: {
          company_name?: string | null
          created_at?: string
          email: string
          employees?: string | null
          id?: string
          ip_hash?: string | null
          phone?: string | null
          source?: string | null
          trade?: string | null
          user_agent?: string | null
        }
        Update: {
          company_name?: string | null
          created_at?: string
          email?: string
          employees?: string | null
          id?: string
          ip_hash?: string | null
          phone?: string | null
          source?: string | null
          trade?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      whatsapp_number_routes: {
        Row: {
          active: boolean
          created_at: string
          display_phone_number: string | null
          id: string
          org_id: string
          phone_number_id: string
          updated_at: string
          waba_id: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_phone_number?: string | null
          id?: string
          org_id: string
          phone_number_id: string
          updated_at?: string
          waba_id?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          display_phone_number?: string | null
          id?: string
          org_id?: string
          phone_number_id?: string
          updated_at?: string
          waba_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_number_routes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_webhook_events: {
        Row: {
          claimed_at: string | null
          created_at: string
          error_message: string | null
          event_key: string
          id: string
          kind: string
          org_id: string | null
          payload: Json
          phone_number_id: string | null
          processed_at: string | null
          status: string | null
          wamid: string
        }
        Insert: {
          claimed_at?: string | null
          created_at?: string
          error_message?: string | null
          event_key: string
          id?: string
          kind: string
          org_id?: string | null
          payload: Json
          phone_number_id?: string | null
          processed_at?: string | null
          status?: string | null
          wamid: string
        }
        Update: {
          claimed_at?: string | null
          created_at?: string
          error_message?: string | null
          event_key?: string
          id?: string
          kind?: string
          org_id?: string | null
          payload?: Json
          phone_number_id?: string | null
          processed_at?: string | null
          status?: string | null
          wamid?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_webhook_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      ai_reply_lifecycle: {
        Row: {
          allowed: boolean | null
          attempt: number | null
          audit_at: string | null
          audit_id: string | null
          categories: string[] | null
          channel: string | null
          correlation_id: string | null
          cost_usd: number | null
          customer_ref: string | null
          dedup_key: string | null
          delivery_error_code: string | null
          delivery_provider_status: string | null
          delivery_status: string | null
          delivery_terminal: boolean | null
          draft: string | null
          employee_slug: string | null
          enforcement_reason: string | null
          enquiry_id: string | null
          latency_ms: number | null
          lead_id: string | null
          org_id: string | null
          provider_message_id: string | null
          receipt_at: string | null
          receipt_count: number | null
          receipt_id: string | null
          safe_text: string | null
          to_ref: string | null
          transport_at: string | null
          transport_failure_reason: string | null
          transport_id: string | null
          transport_provider: string | null
          transport_status: string | null
          verdict: string | null
        }
        Relationships: []
      }
      receptionist_conversation_list: {
        Row: {
          channel: string | null
          contact_name: string | null
          contact_ref: string | null
          conversation_id: string | null
          created_at: string | null
          employee_slug: string | null
          first_message_at: string | null
          goal: string | null
          information: Json | null
          intent: string | null
          last_direction: string | null
          last_event_at: string | null
          last_message_at: string | null
          message_count: number | null
          org_id: string | null
          runtime_state: string | null
          status: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "receptionist_conversations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      receptionist_conversation_timeline: {
        Row: {
          audit_id: string | null
          channel: string | null
          conversation_id: string | null
          delivery_error_code: string | null
          delivery_provider_status: string | null
          delivery_status: string | null
          delivery_terminal: boolean | null
          direction: string | null
          enquiry_id: string | null
          event_at: string | null
          inbound_at: string | null
          inbound_caller: string | null
          inbound_confidence: number | null
          inbound_job_type: string | null
          inbound_postcode: string | null
          inbound_status: string | null
          inbound_summary: string | null
          inbound_text: string | null
          inbound_urgency: string | null
          message_id: string | null
          org_id: string | null
          outbound_allowed: boolean | null
          outbound_audit_at: string | null
          outbound_categories: string[] | null
          outbound_correlation_id: string | null
          outbound_customer_ref: string | null
          outbound_draft: string | null
          outbound_employee_slug: string | null
          outbound_enforcement_reason: string | null
          outbound_safe_text: string | null
          outbound_verdict: string | null
          provider_message_id: string | null
          receipt_at: string | null
          receipt_count: number | null
          receipt_id: string | null
          transport_at: string | null
          transport_failure_reason: string | null
          transport_id: string | null
          transport_provider: string | null
          transport_status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "receptionist_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "receptionist_conversation_list"
            referencedColumns: ["conversation_id"]
          },
          {
            foreignKeyName: "receptionist_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "receptionist_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receptionist_messages_enquiry_id_fkey"
            columns: ["enquiry_id"]
            isOneToOne: false
            referencedRelation: "inbound_enquiries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receptionist_messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      receptionist_coordination_read_model: {
        Row: {
          action_id: string | null
          approval_state: string | null
          authorisation_id: string | null
          autonomous: boolean | null
          conversation_id: string | null
          coordination_at: string | null
          coordination_id: string | null
          coordination_mode: string | null
          coordination_outcome: string | null
          coordination_status: string | null
          coordination_type: string | null
          correlation_id: string | null
          customer_ref: string | null
          enquiry_id: string | null
          execution_id: string | null
          fulfilment_at: string | null
          fulfilment_id: string | null
          fulfilment_outcome: string | null
          fulfilment_status: string | null
          fulfilment_type: string | null
          job_type: string | null
          lead_id: string | null
          lead_participant: string | null
          lifecycle_at: string | null
          lifecycle_closed: boolean | null
          lifecycle_id: string | null
          lifecycle_ongoing: boolean | null
          lifecycle_outcome: string | null
          lifecycle_state: string | null
          lifecycle_status: string | null
          lifecycle_transition: string | null
          lifecycle_type: string | null
          orchestration_active: boolean | null
          orchestration_at: string | null
          orchestration_concluded: boolean | null
          orchestration_id: string | null
          orchestration_outcome: string | null
          orchestration_route: string | null
          orchestration_status: string | null
          orchestration_target: string | null
          orchestration_type: string | null
          org_id: string | null
          participant_count: number | null
          phone_number: string | null
          postcode: string | null
          recovery_at: string | null
          recovery_classification: string | null
          recovery_id: string | null
          recovery_integrity: string | null
          recovery_outcome: string | null
          recovery_required: boolean | null
          recovery_status: string | null
          recovery_type: string | null
          requires_human: boolean | null
          resolution_at: string | null
          resolution_id: string | null
          resolution_intervention_required: boolean | null
          resolution_outcome: string | null
          resolution_recovery_classification: string | null
          resolution_state: string | null
          resolution_status: string | null
          resolution_terminal: boolean | null
          resolution_type: string | null
          review_audit_id: string | null
          review_resolution_id: string | null
          sent_audit_id: string | null
          verification_at: string | null
          verification_id: string | null
          verification_integrity: string | null
          verification_outcome: string | null
          verification_status: string | null
          verification_type: string | null
        }
        Relationships: []
      }
      receptionist_review_queue: {
        Row: {
          assigned_at: string | null
          assigned_by: string | null
          assignee_id: string | null
          categories: string[] | null
          channel: string | null
          contact_name: string | null
          contact_ref: string | null
          conversation_id: string | null
          conversation_status: string | null
          correlation_id: string | null
          customer_ref: string | null
          draft: string | null
          employee_slug: string | null
          enquiry_id: string | null
          held_at: string | null
          last_message_at: string | null
          lead_id: string | null
          message_count: number | null
          metadata: Json | null
          org_id: string | null
          reason: string | null
          resolution: string | null
          resolution_edited: boolean | null
          resolution_id: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          resolved_by_email: string | null
          review_audit_id: string | null
          safe_text: string | null
          sent_audit_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "receptionist_conversations_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receptionist_conversations_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _record_activity: {
        Args: {
          p_action: string
          p_actor_override?: string
          p_metadata?: Json
          p_org_id: string
          p_target_id: string
          p_target_table: string
        }
        Returns: undefined
      }
      append_job_photo: {
        Args: { photo_path: string; target_job_id: string }
        Returns: undefined
      }
      append_receptionist_message: {
        Args: {
          p_audit_id?: string
          p_channel: string
          p_conversation_id: string
          p_direction: string
          p_enquiry_id?: string
          p_org_id: string
        }
        Returns: string
      }
      asset_inspection_fail_is_cleared: {
        Args: { p_inspection_id: string }
        Returns: boolean
      }
      assign_receptionist_conversation: {
        Args: {
          p_assigned_by?: string
          p_assignee_id: string
          p_conversation_id: string
          p_org_id: string
        }
        Returns: string
      }
      current_org_ids: { Args: never; Returns: string[] }
      find_receptionist_coordination_context: {
        Args: { p_org_id: string; p_review_audit_id: string }
        Returns: {
          action_id: string
          active: boolean
          approval_state: string
          authorisation_id: string
          concluded: boolean
          conversation_id: string
          correlation_id: string
          customer_ref: string
          enquiry_id: string
          execution_id: string
          fulfilment_id: string
          job_type: string
          lead_id: string
          lifecycle_id: string
          lifecycle_state: string
          orchestration_id: string
          orchestration_outcome: string
          orchestration_route: string
          orchestration_target: string
          orchestration_type: string
          phone_number: string
          postcode: string
          recovery_id: string
          resolution_id: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          verification_id: string
        }[]
      }
      find_receptionist_fulfilment_reconciliation: {
        Args: { p_org_id: string; p_review_audit_id: string }
        Returns: {
          action_id: string
          authorisation_id: string
          authorisation_state: string
          conversation_id: string
          correlation_id: string
          customer_ref: string
          enquiry_id: string
          execution_eligibility: string
          execution_id: string
          fulfilment_id: string
          job_type: string
          lead_id: string
          phone_number: string
          postcode: string
          recorded_approval_state: string
          recorded_fulfilment_outcome: string
          recorded_fulfilment_type: string
          recorded_job_type: string
          recorded_phone_number: string
          recorded_postcode: string
          recorded_status: string
          requirement: string
        }[]
      }
      find_receptionist_lifecycle_context: {
        Args: { p_org_id: string; p_review_audit_id: string }
        Returns: {
          action_id: string
          approval_state: string
          authorisation_id: string
          conversation_id: string
          correlation_id: string
          customer_ref: string
          enquiry_id: string
          execution_id: string
          fulfilment_id: string
          intervention_required: boolean
          job_type: string
          lead_id: string
          phone_number: string
          postcode: string
          recovery_classification: string
          recovery_id: string
          resolution_id: string
          resolution_outcome: string
          resolution_state: string
          resolution_type: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          terminal: boolean
          verification_id: string
        }[]
      }
      find_receptionist_orchestration_context: {
        Args: { p_org_id: string; p_review_audit_id: string }
        Returns: {
          action_id: string
          approval_state: string
          authorisation_id: string
          closed: boolean
          conversation_id: string
          correlation_id: string
          customer_ref: string
          enquiry_id: string
          execution_id: string
          fulfilment_id: string
          job_type: string
          lead_id: string
          lifecycle_id: string
          lifecycle_outcome: string
          lifecycle_state: string
          lifecycle_transition: string
          lifecycle_type: string
          ongoing: boolean
          phone_number: string
          postcode: string
          recovery_id: string
          resolution_id: string
          resolution_state: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          verification_id: string
        }[]
      }
      find_receptionist_pending_booking_authorisation: {
        Args: { p_org_id: string; p_review_audit_id: string }
        Returns: {
          action_id: string
          authorisation_id: string
          authorisation_state: string
          conversation_id: string
          correlation_id: string
          customer_ref: string
          enquiry_id: string
          execution_eligibility: string
          execution_id: string
          job_type: string
          lead_id: string
          phone_number: string
          postcode: string
          requirement: string
        }[]
      }
      find_receptionist_recovery_context: {
        Args: { p_org_id: string; p_review_audit_id: string }
        Returns: {
          action_id: string
          approval_state: string
          authorisation_id: string
          conversation_id: string
          correlation_id: string
          customer_ref: string
          enquiry_id: string
          execution_id: string
          fulfilment_id: string
          integrity: string
          job_type: string
          lead_id: string
          phone_number: string
          postcode: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          verification_id: string
          verification_outcome: string
          verification_type: string
        }[]
      }
      find_receptionist_resolution_context: {
        Args: { p_org_id: string; p_review_audit_id: string }
        Returns: {
          action_id: string
          approval_state: string
          authorisation_id: string
          conversation_id: string
          correlation_id: string
          customer_ref: string
          enquiry_id: string
          execution_id: string
          fulfilment_id: string
          integrity: string
          job_type: string
          lead_id: string
          phone_number: string
          postcode: string
          recovery_classification: string
          recovery_id: string
          recovery_outcome: string
          recovery_required: boolean
          recovery_type: string
          review_audit_id: string
          review_resolution_id: string
          sent_audit_id: string
          verification_id: string
        }[]
      }
      hq_ai_task_cancel: {
        Args: {
          p_actor_id?: string
          p_actor_type?: string
          p_reason?: string
          p_task_id: string
        }
        Returns: Json
      }
      hq_ai_task_checkpoint: {
        Args: { p_lease_owner: string; p_result: Json; p_task_id: string }
        Returns: boolean
      }
      hq_ai_task_claim: {
        Args: {
          p_lease_owner: string
          p_lease_seconds?: number
          p_task_type: string
        }
        Returns: Json
      }
      hq_ai_task_complete: {
        Args: { p_lease_owner: string; p_result?: Json; p_task_id: string }
        Returns: Json
      }
      hq_ai_task_create: {
        Args: {
          p_assigned_employee_id?: string
          p_correlation_id?: string
          p_created_by?: string
          p_dedupe_key?: string
          p_depends_on?: string[]
          p_max_retries?: number
          p_origin?: string
          p_parent_task_id?: string
          p_payload?: Json
          p_priority?: string
          p_required_capability?: string
          p_scheduled_at?: string
          p_subject_id?: string
          p_subject_kind?: string
          p_task_type: string
        }
        Returns: Json
      }
      hq_ai_task_emit: {
        Args: {
          p_actor_id: string
          p_actor_type: string
          p_extra?: Json
          p_severity: string
          p_task: Database["public"]["Tables"]["hq_ai_tasks"]["Row"]
          p_verb: string
        }
        Returns: number
      }
      hq_ai_task_fail: {
        Args: {
          p_error: string
          p_lease_owner: string
          p_retryable?: boolean
          p_task_id: string
        }
        Returns: Json
      }
      hq_ai_task_heartbeat: {
        Args: {
          p_lease_owner: string
          p_lease_seconds?: number
          p_task_id: string
        }
        Returns: boolean
      }
      hq_ai_task_reap: {
        Args: { p_limit?: number; p_task_type?: string }
        Returns: number
      }
      hq_author_employee_capabilities: {
        Args: {
          p_actor_email?: string
          p_actor_id?: string
          p_slug: string
          p_tokens: string[]
        }
        Returns: Json
      }
      hq_author_employee_memory_scope: {
        Args: {
          p_actor_email?: string
          p_actor_id?: string
          p_memory_scope: string
          p_slug: string
        }
        Returns: Json
      }
      hq_backfill_drain: {
        Args: { p_max_rows?: number; p_source: string }
        Returns: Json
      }
      hq_backfill_emit: {
        Args: {
          p_actor_id: string
          p_actor_type: string
          p_created_at: string
          p_object_id: string
          p_object_type: string
          p_payload: Json
          p_severity: string
          p_source: string
          p_source_id: string
          p_verb: string
        }
        Returns: boolean
      }
      hq_backfill_register: { Args: { p_source: string }; Returns: undefined }
      hq_backfill_reset: { Args: { p_source: string }; Returns: Json }
      hq_backfill_status: { Args: never; Returns: Json }
      hq_consumer_apply: {
        Args: {
          p_consumer: string
          p_event: Database["public"]["Tables"]["hq_events"]["Row"]
        }
        Returns: undefined
      }
      hq_consumer_register: {
        Args: { p_consumer: string; p_start_event_id?: number }
        Returns: undefined
      }
      hq_create_events_partition: {
        Args: { p_anchor?: string }
        Returns: string
      }
      hq_drain_consumer: {
        Args: {
          p_consumer: string
          p_max_attempts?: number
          p_max_events?: number
        }
        Returns: Json
      }
      hq_embedding_claim_batch: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: Json
      }
      hq_embedding_complete: {
        Args: {
          p_checksum: string
          p_cost?: number
          p_dimension: number
          p_embedding: number[]
          p_latency_ms?: number
          p_memory_id: string
          p_model: string
          p_provider: string
          p_tokens?: number
          p_version: string
          p_worker_id: string
        }
        Returns: Json
      }
      hq_embedding_enqueue_stale: {
        Args: { p_limit?: number; p_target_version: string }
        Returns: number
      }
      hq_embedding_fail: {
        Args: {
          p_error: string
          p_max_attempts?: number
          p_memory_id: string
          p_model: string
          p_provider: string
          p_worker_id: string
        }
        Returns: Json
      }
      hq_embedding_golden_signals: {
        Args: { p_target_version?: string }
        Returns: Json
      }
      hq_embedding_reclaim_stale: {
        Args: { p_lease_seconds?: number; p_limit?: number }
        Returns: number
      }
      hq_embedding_reset_failed: { Args: { p_limit?: number }; Returns: number }
      hq_emit_event: {
        Args: {
          p_actor_id: string
          p_actor_type: string
          p_causation_id?: number
          p_correlation_id: string
          p_object_id: string
          p_object_type: string
          p_payload?: Json
          p_severity?: string
          p_target_id?: string
          p_target_type?: string
          p_verb: string
          p_visibility?: string
        }
        Returns: number
      }
      hq_emit_from_activity: {
        Args: {
          p_action: string
          p_actor_id: string
          p_actor_name: string
          p_metadata: Json
          p_org_id: string
          p_target_id: string
          p_target_table: string
        }
        Returns: undefined
      }
      hq_employee_has_capability: {
        Args: { p_employee_id: string; p_token: string }
        Returns: boolean
      }
      hq_memory_archive: {
        Args: { p_memory_id: string; p_reason?: string }
        Returns: Json
      }
      hq_memory_consolidate: {
        Args: { p_employee_id: string; p_theme: string }
        Returns: string
      }
      hq_memory_dedupe_pairs: {
        Args: { p_limit?: number; p_threshold?: number }
        Returns: Json
      }
      hq_memory_embed_enabled: { Args: never; Returns: boolean }
      hq_memory_expire_sweep: {
        Args: { p_limit?: number; p_now?: string }
        Returns: Json
      }
      hq_memory_forget: {
        Args: { p_employee_id: string; p_memory_id: string; p_reason?: string }
        Returns: Json
      }
      hq_memory_golden_signals: { Args: never; Returns: Json }
      hq_memory_lifecycle_enabled: { Args: never; Returns: boolean }
      hq_memory_recall: {
        Args: {
          p_class_filter?: string[]
          p_employee_id: string
          p_limit?: number
          p_query?: string
          p_query_embedding?: number[]
          p_query_version?: string
          p_subject_id?: string
          p_subject_kind?: string
        }
        Returns: Json
      }
      hq_memory_reinforce: {
        Args: { p_employee_id: string; p_memory_ids: string[] }
        Returns: undefined
      }
      hq_memory_set_summary: {
        Args: { p_memory_id: string; p_summary: string }
        Returns: Json
      }
      hq_memory_summary_candidates: {
        Args: { p_limit?: number }
        Returns: Json
      }
      hq_memory_supersede: {
        Args: { p_drop_id: string; p_keep_id: string; p_reason?: string }
        Returns: Json
      }
      hq_memory_write: {
        Args: {
          p_body?: string
          p_bound_task_id?: string
          p_class: string
          p_context?: Json
          p_correlation_id?: string
          p_employee_id: string
          p_expires_at?: string
          p_owner?: string
          p_salience?: number
          p_summary?: string
          p_title: string
          p_type: string
          p_visibility?: string
        }
        Returns: string
      }
      hq_record_executor_shadow: {
        Args: {
          p_action_id: string
          p_correlation_id: string
          p_detail?: string
          p_idempotency_key?: string
          p_outcome: string
          p_reason?: string
          p_source: string
          p_task_id: string
          p_tool_label?: string
        }
        Returns: number
      }
      hq_replay_consumer: {
        Args: { p_consumer: string; p_to_event_id?: number }
        Returns: Json
      }
      hq_spine_backfill_enabled: { Args: never; Returns: boolean }
      hq_spine_consumer_enabled: { Args: never; Returns: boolean }
      hq_spine_dual_write_enabled: { Args: never; Returns: boolean }
      hq_spine_golden_signals: { Args: never; Returns: Json }
      hq_timeline_event: { Args: { p_event_id: number }; Returns: Json }
      hq_timeline_facets: { Args: never; Returns: Json }
      hq_timeline_page: {
        Args: {
          p_actor_types?: string[]
          p_before_id?: number
          p_before_ts?: string
          p_limit?: number
          p_namespaces?: string[]
          p_search?: string
          p_severities?: string[]
        }
        Returns: Json
      }
      hq_timeline_reset: { Args: never; Returns: Json }
      is_org_admin: { Args: { target_org: string }; Returns: boolean }
      is_org_member: { Args: { target_org: string }; Returns: boolean }
      next_invoice_number: { Args: { target_org: string }; Returns: string }
      next_po_number: { Args: { target_org: string }; Returns: string }
      next_quote_number: { Args: { target_org: string }; Returns: string }
      next_variation_number: { Args: { target_job: string }; Returns: number }
      publish_inspection_template: {
        Args: { p_org_id: string; p_template_id: string; p_user: string }
        Returns: undefined
      }
      purge_activity_log: {
        Args: { p_batch?: number; p_retention?: string }
        Returns: number
      }
      rate_limit_hit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: {
          allowed: boolean
          remaining: number
          reset_at: string
        }[]
      }
      rate_limit_sweep: { Args: never; Returns: undefined }
      record_ai_reply_audit: {
        Args: {
          p_allowed: boolean
          p_categories?: string[]
          p_channel: string
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_draft: string
          p_employee_slug: string
          p_enquiry_id?: string
          p_lead_id?: string
          p_metadata?: Json
          p_org_id: string
          p_reason: string
          p_safe_text?: string
          p_verdict: string
        }
        Returns: string
      }
      record_ai_reply_delivery_receipt: {
        Args: {
          p_error_code?: string
          p_metadata?: Json
          p_provider_message_id: string
          p_provider_status?: string
          p_status: string
        }
        Returns: {
          is_terminal: boolean
          org_id: string
          receipt_id: string
          reply_audit_id: string
          transport_found: boolean
          transport_id: string
          was_duplicate: boolean
        }[]
      }
      record_ai_reply_transport: {
        Args: {
          p_attempt?: number
          p_channel: string
          p_correlation_id: string
          p_cost_usd?: number
          p_dedup_key?: string
          p_employee_slug: string
          p_failure_reason?: string
          p_latency_ms?: number
          p_metadata?: Json
          p_org_id: string
          p_provider?: string
          p_provider_message_id?: string
          p_reply_audit_id: string
          p_status: string
          p_to_ref: string
        }
        Returns: string
      }
      record_receptionist_conversation_action: {
        Args: {
          p_action_type: string
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_enquiry_id?: string
          p_job_type?: string
          p_lead_id?: string
          p_metadata?: Json
          p_org_id: string
          p_phone_number?: string
          p_postcode?: string
        }
        Returns: string
      }
      record_receptionist_conversation_authorisation: {
        Args: {
          p_action_id?: string
          p_authorisation_state: string
          p_authorisation_type: string
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_enquiry_id?: string
          p_execution_eligibility: string
          p_execution_id?: string
          p_job_type?: string
          p_lead_id?: string
          p_metadata?: Json
          p_org_id: string
          p_phone_number?: string
          p_postcode?: string
          p_requirement: string
          p_review_audit_id?: string
        }
        Returns: string
      }
      record_receptionist_conversation_claim: {
        Args: {
          p_claim_outcome: string
          p_claim_type: string
          p_conversation_id?: string
          p_coordination_id: string
          p_correlation_id?: string
          p_metadata?: Json
          p_operator_email?: string
          p_operator_id: string
          p_org_id: string
        }
        Returns: string
      }
      record_receptionist_conversation_claim_reassignment: {
        Args: {
          p_conversation_id?: string
          p_coordination_id: string
          p_correlation_id?: string
          p_from_operator_email?: string
          p_from_operator_id: string
          p_metadata?: Json
          p_org_id: string
          p_reassignment_outcome: string
          p_reassignment_type: string
          p_request_id?: string
          p_to_operator_email?: string
          p_to_operator_id: string
        }
        Returns: string
      }
      record_receptionist_conversation_claim_release: {
        Args: {
          p_conversation_id?: string
          p_coordination_id: string
          p_correlation_id?: string
          p_metadata?: Json
          p_operator_email?: string
          p_operator_id: string
          p_org_id: string
          p_release_outcome: string
          p_release_type: string
        }
        Returns: string
      }
      record_receptionist_conversation_coordination: {
        Args: {
          p_action_id?: string
          p_approval_state: string
          p_authorisation_id: string
          p_autonomous: boolean
          p_conversation_id?: string
          p_coordination_mode: string
          p_coordination_outcome: string
          p_coordination_type: string
          p_correlation_id: string
          p_customer_ref?: string
          p_enquiry_id?: string
          p_execution_id?: string
          p_fulfilment_id?: string
          p_job_type?: string
          p_lead_id?: string
          p_lead_participant: string
          p_lifecycle_id: string
          p_lifecycle_state: string
          p_metadata?: Json
          p_orchestration_id: string
          p_orchestration_route: string
          p_org_id: string
          p_participant_count: number
          p_phone_number?: string
          p_postcode?: string
          p_recovery_id: string
          p_requires_human: boolean
          p_resolution_id: string
          p_review_audit_id: string
          p_review_resolution_id: string
          p_sent_audit_id: string
          p_verification_id: string
        }
        Returns: string
      }
      record_receptionist_conversation_execution: {
        Args: {
          p_action_id?: string
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_eligibility: string
          p_enquiry_id?: string
          p_execution_type: string
          p_job_type?: string
          p_lead_id?: string
          p_live_execution: boolean
          p_metadata?: Json
          p_org_id: string
          p_phone_number?: string
          p_policy_verdict: string
          p_postcode?: string
        }
        Returns: string
      }
      record_receptionist_conversation_fulfilment: {
        Args: {
          p_action_id?: string
          p_approval_state: string
          p_authorisation_id: string
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_enquiry_id?: string
          p_execution_id?: string
          p_fulfilment_outcome: string
          p_fulfilment_type: string
          p_job_type?: string
          p_lead_id?: string
          p_metadata?: Json
          p_org_id: string
          p_phone_number?: string
          p_postcode?: string
          p_review_audit_id: string
          p_review_resolution_id: string
          p_sent_audit_id: string
        }
        Returns: string
      }
      record_receptionist_conversation_lifecycle: {
        Args: {
          p_action_id?: string
          p_approval_state: string
          p_authorisation_id: string
          p_closed: boolean
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_enquiry_id?: string
          p_execution_id?: string
          p_fulfilment_id?: string
          p_job_type?: string
          p_lead_id?: string
          p_lifecycle_outcome: string
          p_lifecycle_state: string
          p_lifecycle_transition: string
          p_lifecycle_type: string
          p_metadata?: Json
          p_ongoing: boolean
          p_org_id: string
          p_phone_number?: string
          p_postcode?: string
          p_recovery_id: string
          p_resolution_id: string
          p_resolution_state: string
          p_review_audit_id: string
          p_review_resolution_id: string
          p_sent_audit_id: string
          p_verification_id: string
        }
        Returns: string
      }
      record_receptionist_conversation_orchestration: {
        Args: {
          p_action_id?: string
          p_active: boolean
          p_approval_state: string
          p_authorisation_id: string
          p_concluded: boolean
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_enquiry_id?: string
          p_execution_id?: string
          p_fulfilment_id?: string
          p_job_type?: string
          p_lead_id?: string
          p_lifecycle_id: string
          p_lifecycle_state: string
          p_metadata?: Json
          p_orchestration_outcome: string
          p_orchestration_route: string
          p_orchestration_target: string
          p_orchestration_type: string
          p_org_id: string
          p_phone_number?: string
          p_postcode?: string
          p_recovery_id: string
          p_resolution_id: string
          p_review_audit_id: string
          p_review_resolution_id: string
          p_sent_audit_id: string
          p_verification_id: string
        }
        Returns: string
      }
      record_receptionist_conversation_outcome: {
        Args: {
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_enquiry_id?: string
          p_lead_id?: string
          p_metadata?: Json
          p_org_id: string
          p_outcome_type: string
          p_phone_number?: string
        }
        Returns: string
      }
      record_receptionist_conversation_recovery: {
        Args: {
          p_action_id?: string
          p_approval_state: string
          p_authorisation_id: string
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_enquiry_id?: string
          p_execution_id?: string
          p_fulfilment_id?: string
          p_integrity: string
          p_job_type?: string
          p_lead_id?: string
          p_metadata?: Json
          p_org_id: string
          p_phone_number?: string
          p_postcode?: string
          p_recovery_classification: string
          p_recovery_outcome: string
          p_recovery_required: boolean
          p_recovery_type: string
          p_review_audit_id: string
          p_review_resolution_id: string
          p_sent_audit_id: string
          p_verification_id: string
        }
        Returns: string
      }
      record_receptionist_conversation_resolution: {
        Args: {
          p_action_id?: string
          p_approval_state: string
          p_authorisation_id: string
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_enquiry_id?: string
          p_execution_id?: string
          p_fulfilment_id?: string
          p_intervention_required: boolean
          p_job_type?: string
          p_lead_id?: string
          p_metadata?: Json
          p_org_id: string
          p_phone_number?: string
          p_postcode?: string
          p_recovery_classification: string
          p_recovery_id: string
          p_resolution_outcome: string
          p_resolution_state: string
          p_resolution_type: string
          p_review_audit_id: string
          p_review_resolution_id: string
          p_sent_audit_id: string
          p_terminal: boolean
          p_verification_id: string
        }
        Returns: string
      }
      record_receptionist_conversation_verification: {
        Args: {
          p_action_id?: string
          p_approval_state: string
          p_authorisation_id: string
          p_conversation_id?: string
          p_correlation_id: string
          p_customer_ref?: string
          p_enquiry_id?: string
          p_execution_id?: string
          p_fulfilment_id?: string
          p_integrity: string
          p_job_type?: string
          p_lead_id?: string
          p_metadata?: Json
          p_org_id: string
          p_phone_number?: string
          p_postcode?: string
          p_review_audit_id: string
          p_review_resolution_id: string
          p_sent_audit_id: string
          p_verification_outcome: string
          p_verification_type: string
        }
        Returns: string
      }
      record_receptionist_review_resolution: {
        Args: {
          p_conversation_id?: string
          p_edited?: boolean
          p_note?: string
          p_org_id: string
          p_resolution: string
          p_resolved_by: string
          p_resolved_by_email?: string
          p_review_audit_id: string
          p_sent_audit_id?: string
        }
        Returns: string
      }
      remove_job_photo: {
        Args: { photo_path: string; target_job_id: string }
        Returns: undefined
      }
      resolve_receptionist_conversation: {
        Args: {
          p_channel: string
          p_contact_name?: string
          p_contact_ref: string
          p_employee_slug: string
          p_org_id: string
        }
        Returns: string
      }
      rotate_asset_qr_identity: {
        Args: {
          p_asset_id: string
          p_generated_by: string
          p_org_id: string
          p_token: string
        }
        Returns: string
      }
      set_receptionist_conversation_goal: {
        Args: { p_conversation_id: string; p_goal: string; p_org_id: string }
        Returns: undefined
      }
      set_receptionist_conversation_information: {
        Args: {
          p_conversation_id: string
          p_information: Json
          p_org_id: string
        }
        Returns: undefined
      }
      set_receptionist_conversation_intent: {
        Args: { p_conversation_id: string; p_intent: string; p_org_id: string }
        Returns: undefined
      }
      set_receptionist_conversation_runtime_state: {
        Args: {
          p_conversation_id: string
          p_org_id: string
          p_runtime_state: string
        }
        Returns: undefined
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      transfer_asset_assignment: {
        Args: {
          p_asset_id: string
          p_assigned_by: string
          p_assignee_id: string
          p_assignment_type: string
          p_expected_return_at: string
          p_issue_condition: string
          p_issue_notes: string
          p_job_id: string
          p_location: string
          p_org_id: string
          p_vehicle_asset_id: string
        }
        Returns: string
      }
    }
    Enums: {
      invoice_status:
        | "draft"
        | "sent"
        | "awaiting_payment"
        | "partially_paid"
        | "paid"
        | "overdue"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      invoice_status: [
        "draft",
        "sent",
        "awaiting_payment",
        "partially_paid",
        "paid",
        "overdue",
      ],
    },
  },
} as const
