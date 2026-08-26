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
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      accounting_connections: {
        Row: {
          access_token: string | null
          connected_at: string | null
          connected_by: string | null
          created_at: string
          external_tenant_id: string | null
          id: string
          last_error: string | null
          last_sync_at: string | null
          org_id: string
          provider: string
          realm_id: string | null
          refresh_token: string | null
          status: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          external_tenant_id?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          org_id: string
          provider: string
          realm_id?: string | null
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          external_tenant_id?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          org_id?: string
          provider?: string
          realm_id?: string | null
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounting_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounting_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      accounting_export_log: {
        Row: {
          created_at: string
          created_by: string | null
          format: string
          id: string
          note: string | null
          org_id: string
          period_end: string | null
          period_start: string | null
          row_count: number
          status: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          format: string
          id?: string
          note?: string | null
          org_id: string
          period_end?: string | null
          period_start?: string | null
          row_count?: number
          status: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          format?: string
          id?: string
          note?: string | null
          org_id?: string
          period_end?: string | null
          period_start?: string | null
          row_count?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounting_export_log_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounting_export_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      accounting_pushed_entities: {
        Row: {
          created_by: string | null
          entity_id: string
          entity_type: string
          id: string
          org_id: string
          provider: string
          pushed_at: string
        }
        Insert: {
          created_by?: string | null
          entity_id: string
          entity_type: string
          id?: string
          org_id: string
          provider: string
          pushed_at?: string
        }
        Update: {
          created_by?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          org_id?: string
          provider?: string
          pushed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounting_pushed_entities_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounting_pushed_entities_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
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
      ai_budget_control_audit: {
        Row: {
          action: string
          changed_by: string | null
          changed_by_email: string | null
          control_type: string
          created_at: string
          id: string
          new_pence: number | null
          note: string | null
          old_pence: number | null
          org_id: string
          target_user_id: string | null
        }
        Insert: {
          action: string
          changed_by?: string | null
          changed_by_email?: string | null
          control_type: string
          created_at?: string
          id?: string
          new_pence?: number | null
          note?: string | null
          old_pence?: number | null
          org_id: string
          target_user_id?: string | null
        }
        Update: {
          action?: string
          changed_by?: string | null
          changed_by_email?: string | null
          control_type?: string
          created_at?: string
          id?: string
          new_pence?: number | null
          note?: string | null
          old_pence?: number | null
          org_id?: string
          target_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_budget_control_audit_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_budget_control_audit_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_budget_control_audit_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_cost_reservations: {
        Row: {
          content_hash: string | null
          cost_pence: number | null
          created_at: string
          estimate_pence: number
          expires_at: string
          feature: string
          id: string
          invocation_id: string | null
          org_id: string
          release_reason: string | null
          settled_at: string | null
          state: string
          success: boolean | null
          task_class: string
          user_id: string | null
        }
        Insert: {
          content_hash?: string | null
          cost_pence?: number | null
          created_at?: string
          estimate_pence: number
          expires_at: string
          feature: string
          id?: string
          invocation_id?: string | null
          org_id: string
          release_reason?: string | null
          settled_at?: string | null
          state?: string
          success?: boolean | null
          task_class: string
          user_id?: string | null
        }
        Update: {
          content_hash?: string | null
          cost_pence?: number | null
          created_at?: string
          estimate_pence?: number
          expires_at?: string
          feature?: string
          id?: string
          invocation_id?: string | null
          org_id?: string
          release_reason?: string | null
          settled_at?: string | null
          state?: string
          success?: boolean | null
          task_class?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_cost_reservations_invocation_id_fkey"
            columns: ["invocation_id"]
            isOneToOne: false
            referencedRelation: "ai_invocations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_cost_reservations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_cost_reservations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_employee_budget_limits: {
        Row: {
          created_at: string
          id: string
          limit_pence: number
          note: string | null
          org_id: string
          set_by: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          limit_pence: number
          note?: string | null
          org_id: string
          set_by?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          limit_pence?: number
          note?: string | null
          org_id?: string
          set_by?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_employee_budget_limits_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_employee_budget_limits_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_employee_budget_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
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
      ai_invocations: {
        Row: {
          content_hash: string | null
          created_at: string
          error_code: string | null
          estimated_cost_pence: number
          feature: string
          id: string
          input_tokens: number
          latency_ms: number
          model: string
          org_id: string
          output_tokens: number
          provider: string
          success: boolean
          task_class: string
          user_id: string | null
        }
        Insert: {
          content_hash?: string | null
          created_at?: string
          error_code?: string | null
          estimated_cost_pence?: number
          feature: string
          id?: string
          input_tokens?: number
          latency_ms: number
          model: string
          org_id: string
          output_tokens?: number
          provider: string
          success: boolean
          task_class: string
          user_id?: string | null
        }
        Update: {
          content_hash?: string | null
          created_at?: string
          error_code?: string | null
          estimated_cost_pence?: number
          feature?: string
          id?: string
          input_tokens?: number
          latency_ms?: number
          model?: string
          org_id?: string
          output_tokens?: number
          provider?: string
          success?: boolean
          task_class?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_invocations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_invocations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_org_budget_ceilings: {
        Row: {
          ceiling_pence: number
          created_at: string
          note: string | null
          org_id: string
          set_by: string | null
          updated_at: string
        }
        Insert: {
          ceiling_pence: number
          created_at?: string
          note?: string | null
          org_id: string
          set_by?: string | null
          updated_at?: string
        }
        Update: {
          ceiling_pence?: number
          created_at?: string
          note?: string | null
          org_id?: string
          set_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_org_budget_ceilings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_org_budget_ceilings_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_quote_drafts: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          applied_content: Json | null
          content: Json
          context_fields: string[]
          created_at: string
          created_by: string | null
          degraded: boolean
          discarded_at: string | null
          discarded_by: string | null
          id: string
          invocation_hash: string | null
          lead_id: string | null
          model: string
          org_id: string
          prompt_checksum: string
          prompt_version: string
          provenance: string
          quote_id: string | null
          schema_version: number
          status: string
          updated_at: string
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          applied_content?: Json | null
          content: Json
          context_fields?: string[]
          created_at?: string
          created_by?: string | null
          degraded?: boolean
          discarded_at?: string | null
          discarded_by?: string | null
          id?: string
          invocation_hash?: string | null
          lead_id?: string | null
          model: string
          org_id: string
          prompt_checksum: string
          prompt_version: string
          provenance: string
          quote_id?: string | null
          schema_version: number
          status?: string
          updated_at?: string
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          applied_content?: Json | null
          content?: Json
          context_fields?: string[]
          created_at?: string
          created_by?: string | null
          degraded?: boolean
          discarded_at?: string | null
          discarded_by?: string | null
          id?: string
          invocation_hash?: string | null
          lead_id?: string | null
          model?: string
          org_id?: string
          prompt_checksum?: string
          prompt_version?: string
          provenance?: string
          quote_id?: string | null
          schema_version?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_quote_drafts_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_quote_drafts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_quote_drafts_discarded_by_fkey"
            columns: ["discarded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_quote_drafts_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_quote_drafts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_quote_drafts_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
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
      api_keys: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          org_id: string
          revoked_at: string | null
          scopes: string[]
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          org_id: string
          revoked_at?: string | null
          scopes?: string[]
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          org_id?: string
          revoked_at?: string | null
          scopes?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_keys_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      api_request_log: {
        Row: {
          created_at: string
          id: number
          key_id: string
          method: string
          org_id: string
          route: string
          status: number
        }
        Insert: {
          created_at?: string
          id?: never
          key_id: string
          method: string
          org_id: string
          route: string
          status: number
        }
        Update: {
          created_at?: string
          id?: never
          key_id?: string
          method?: string
          org_id?: string
          route?: string
          status?: number
        }
        Relationships: [
          {
            foreignKeyName: "api_request_log_key_id_fkey"
            columns: ["key_id", "org_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "api_request_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
          site_id: string | null
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
          site_id?: string | null
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
          site_id?: string | null
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
            foreignKeyName: "asset_assignments_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
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
      asset_calibration_certificates: {
        Row: {
          asset_id: string
          calibrated_by: string
          calibration_date: string
          certificate_number: string
          created_at: string
          id: string
          next_due_date: string | null
          notes: string | null
          org_id: string
          recorded_by: string | null
          result: string
          schedule_id: string | null
          standard: string | null
          updated_at: string
        }
        Insert: {
          asset_id: string
          calibrated_by: string
          calibration_date: string
          certificate_number: string
          created_at?: string
          id?: string
          next_due_date?: string | null
          notes?: string | null
          org_id: string
          recorded_by?: string | null
          result: string
          schedule_id?: string | null
          standard?: string | null
          updated_at?: string
        }
        Update: {
          asset_id?: string
          calibrated_by?: string
          calibration_date?: string
          certificate_number?: string
          created_at?: string
          id?: string
          next_due_date?: string | null
          notes?: string | null
          org_id?: string
          recorded_by?: string | null
          result?: string
          schedule_id?: string | null
          standard?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_calibration_certificates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_calibration_certificates_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_calibration_certs_asset_org_fk"
            columns: ["asset_id", "org_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "asset_calibration_certs_schedule_org_fk"
            columns: ["schedule_id", "org_id"]
            isOneToOne: false
            referencedRelation: "asset_service_schedules"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      asset_depreciation_settings: {
        Row: {
          annual_rate_pct: number | null
          asset_id: string
          cost: number
          created_at: string
          created_by: string | null
          method: string
          org_id: string
          salvage_value: number
          start_date: string
          updated_at: string
          updated_by: string | null
          useful_life_months: number | null
        }
        Insert: {
          annual_rate_pct?: number | null
          asset_id: string
          cost: number
          created_at?: string
          created_by?: string | null
          method: string
          org_id: string
          salvage_value?: number
          start_date: string
          updated_at?: string
          updated_by?: string | null
          useful_life_months?: number | null
        }
        Update: {
          annual_rate_pct?: number | null
          asset_id?: string
          cost?: number
          created_at?: string
          created_by?: string | null
          method?: string
          org_id?: string
          salvage_value?: number
          start_date?: string
          updated_at?: string
          updated_by?: string | null
          useful_life_months?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_depreciation_settings_asset_org_fk"
            columns: ["asset_id", "org_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "asset_depreciation_settings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_depreciation_settings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_depreciation_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_fuel_logs: {
        Row: {
          asset_id: string
          cost: number
          created_at: string
          created_by: string | null
          driver_id: string | null
          filled_on: string
          id: string
          is_full_fill: boolean
          litres: number | null
          notes: string | null
          odometer_miles: number | null
          org_id: string
          station: string | null
          supplier_id: string | null
          updated_at: string
        }
        Insert: {
          asset_id: string
          cost: number
          created_at?: string
          created_by?: string | null
          driver_id?: string | null
          filled_on: string
          id?: string
          is_full_fill?: boolean
          litres?: number | null
          notes?: string | null
          odometer_miles?: number | null
          org_id: string
          station?: string | null
          supplier_id?: string | null
          updated_at?: string
        }
        Update: {
          asset_id?: string
          cost?: number
          created_at?: string
          created_by?: string | null
          driver_id?: string | null
          filled_on?: string
          id?: string
          is_full_fill?: boolean
          litres?: number | null
          notes?: string | null
          odometer_miles?: number | null
          org_id?: string
          station?: string | null
          supplier_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_fuel_logs_asset_org_fk"
            columns: ["asset_id", "org_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "asset_fuel_logs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_fuel_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_fuel_logs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_fuel_logs_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
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
          odometer_miles: number | null
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
          odometer_miles?: number | null
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
          odometer_miles?: number | null
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
      automation_approvals: {
        Row: {
          correlation_id: string
          created_at: string
          custom_rule_id: string
          decided_at: string | null
          decided_by: string | null
          event_type: string
          executed_at: string | null
          execution_result: Json | null
          id: string
          note: string | null
          org_id: string
          payload: Json
          pending_actions: Json
          rule_name: string
          source_id: string
          source_table: string
          status: string
          updated_at: string
        }
        Insert: {
          correlation_id: string
          created_at?: string
          custom_rule_id: string
          decided_at?: string | null
          decided_by?: string | null
          event_type: string
          executed_at?: string | null
          execution_result?: Json | null
          id?: string
          note?: string | null
          org_id: string
          payload?: Json
          pending_actions?: Json
          rule_name?: string
          source_id: string
          source_table: string
          status?: string
          updated_at?: string
        }
        Update: {
          correlation_id?: string
          created_at?: string
          custom_rule_id?: string
          decided_at?: string | null
          decided_by?: string | null
          event_type?: string
          executed_at?: string | null
          execution_result?: Json | null
          id?: string
          note?: string | null
          org_id?: string
          payload?: Json
          pending_actions?: Json
          rule_name?: string
          source_id?: string
          source_table?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_approvals_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_approvals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_approvals_rule_fk"
            columns: ["custom_rule_id", "org_id"]
            isOneToOne: false
            referencedRelation: "automation_custom_rules"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      automation_custom_rules: {
        Row: {
          created_at: string
          created_by: string | null
          definition: Json
          description: string | null
          enabled: boolean
          graph: Json | null
          graph_version: number
          id: string
          is_draft: boolean
          name: string
          org_id: string
          source: string
          trigger_event: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          definition?: Json
          description?: string | null
          enabled?: boolean
          graph?: Json | null
          graph_version?: number
          id?: string
          is_draft?: boolean
          name: string
          org_id: string
          source?: string
          trigger_event: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          definition?: Json
          description?: string | null
          enabled?: boolean
          graph?: Json | null
          graph_version?: number
          id?: string
          is_draft?: boolean
          name?: string
          org_id?: string
          source?: string
          trigger_event?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "automation_custom_rules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_custom_rules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_custom_rules_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_rules: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          org_id: string
          rule_key: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          org_id: string
          rule_key: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          org_id?: string
          rule_key?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "automation_rules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_rules_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_runs: {
        Row: {
          attempts: number
          claimed_at: string | null
          completed_at: string | null
          correlation_id: string
          created_at: string
          dead_lettered_at: string | null
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
          attempts?: number
          claimed_at?: string | null
          completed_at?: string | null
          correlation_id: string
          created_at?: string
          dead_lettered_at?: string | null
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
          attempts?: number
          claimed_at?: string | null
          completed_at?: string | null
          correlation_id?: string
          created_at?: string
          dead_lettered_at?: string | null
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
      automation_schedules: {
        Row: {
          created_at: string
          created_by: string | null
          cron_expr: string
          enabled: boolean
          id: string
          last_run_at: string | null
          next_run_at: string
          org_id: string
          rule_key: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          cron_expr: string
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          next_run_at: string
          org_id: string
          rule_key: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          cron_expr?: string
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          next_run_at?: string
          org_id?: string
          rule_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_schedules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_schedules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_workflow_versions: {
        Row: {
          compiled_definition: Json
          created_at: string
          created_by: string | null
          custom_rule_id: string
          graph: Json
          id: string
          is_draft: boolean
          note: string | null
          org_id: string
          version: number
        }
        Insert: {
          compiled_definition?: Json
          created_at?: string
          created_by?: string | null
          custom_rule_id: string
          graph?: Json
          id?: string
          is_draft?: boolean
          note?: string | null
          org_id: string
          version: number
        }
        Update: {
          compiled_definition?: Json
          created_at?: string
          created_by?: string | null
          custom_rule_id?: string
          graph?: Json
          id?: string
          is_draft?: boolean
          note?: string | null
          org_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "automation_workflow_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_workflow_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_workflow_versions_rule_fk"
            columns: ["custom_rule_id", "org_id"]
            isOneToOne: false
            referencedRelation: "automation_custom_rules"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      bank_connections: {
        Row: {
          access_token: string | null
          connected_at: string | null
          connected_by: string | null
          connection_ref: string | null
          created_at: string
          id: string
          institution_id: string | null
          institution_name: string | null
          last_error: string | null
          last_sync_at: string | null
          org_id: string
          provider: string
          refresh_token: string | null
          status: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          connected_at?: string | null
          connected_by?: string | null
          connection_ref?: string | null
          created_at?: string
          id?: string
          institution_id?: string | null
          institution_name?: string | null
          last_error?: string | null
          last_sync_at?: string | null
          org_id: string
          provider: string
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          connected_at?: string | null
          connected_by?: string | null
          connection_ref?: string | null
          created_at?: string
          id?: string
          institution_id?: string | null
          institution_name?: string | null
          last_error?: string | null
          last_sync_at?: string | null
          org_id?: string
          provider?: string
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_connections_org_id_fkey"
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
          provider_tx_id: string | null
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
          provider_tx_id?: string | null
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
          provider_tx_id?: string | null
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
      blueprint_markup: {
        Row: {
          bbox_h: number
          bbox_u: number
          bbox_v: number
          bbox_w: number
          blueprint_version_id: string
          color: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          geom: Json
          id: string
          job_id: string
          org_id: string
          page_number: number
          shape: string
          status: string
          stroke_width: number
          text_content: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          bbox_h: number
          bbox_u: number
          bbox_v: number
          bbox_w: number
          blueprint_version_id: string
          color?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          geom: Json
          id?: string
          job_id: string
          org_id: string
          page_number?: number
          shape: string
          status?: string
          stroke_width?: number
          text_content?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          bbox_h?: number
          bbox_u?: number
          bbox_v?: number
          bbox_w?: number
          blueprint_version_id?: string
          color?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          geom?: Json
          id?: string
          job_id?: string
          org_id?: string
          page_number?: number
          shape?: string
          status?: string
          stroke_width?: number
          text_content?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "blueprint_markup_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprint_markup_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprint_markup_version_org_fkey"
            columns: ["blueprint_version_id", "org_id"]
            isOneToOne: false
            referencedRelation: "blueprint_versions"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      blueprint_pin_comments: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          org_id: string
          parent_comment_id: string | null
          pin_id: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          org_id: string
          parent_comment_id?: string | null
          pin_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          org_id?: string
          parent_comment_id?: string | null
          pin_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blueprint_pin_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprint_pin_comments_parent_org_fkey"
            columns: ["parent_comment_id", "org_id"]
            isOneToOne: false
            referencedRelation: "blueprint_pin_comments"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "blueprint_pin_comments_pin_org_fkey"
            columns: ["pin_id", "org_id"]
            isOneToOne: false
            referencedRelation: "blueprint_pins"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      blueprint_pins: {
        Row: {
          assigned_to: string | null
          blueprint_version_id: string
          created_at: string
          created_by: string | null
          due_date: string | null
          id: string
          job_id: string
          kind: string
          note: string | null
          org_id: string
          page_number: number
          snag_id: string | null
          task_status: string | null
          title: string | null
          u: number
          updated_at: string
          v: number
        }
        Insert: {
          assigned_to?: string | null
          blueprint_version_id: string
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          id?: string
          job_id: string
          kind: string
          note?: string | null
          org_id: string
          page_number?: number
          snag_id?: string | null
          task_status?: string | null
          title?: string | null
          u: number
          updated_at?: string
          v: number
        }
        Update: {
          assigned_to?: string | null
          blueprint_version_id?: string
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          id?: string
          job_id?: string
          kind?: string
          note?: string | null
          org_id?: string
          page_number?: number
          snag_id?: string | null
          task_status?: string | null
          title?: string | null
          u?: number
          updated_at?: string
          v?: number
        }
        Relationships: [
          {
            foreignKeyName: "blueprint_pins_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprint_pins_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprint_pins_snag_org_fkey"
            columns: ["snag_id", "org_id"]
            isOneToOne: false
            referencedRelation: "snags"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "blueprint_pins_version_org_fkey"
            columns: ["blueprint_version_id", "org_id"]
            isOneToOne: false
            referencedRelation: "blueprint_versions"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      blueprint_versions: {
        Row: {
          blueprint_id: string
          content_hash: string | null
          file_name: string
          id: string
          mime_type: string
          notes: string | null
          org_id: string
          revision: string
          revision_date: string | null
          size_bytes: number
          storage_bucket: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string | null
          version: number
        }
        Insert: {
          blueprint_id: string
          content_hash?: string | null
          file_name: string
          id?: string
          mime_type: string
          notes?: string | null
          org_id: string
          revision: string
          revision_date?: string | null
          size_bytes: number
          storage_bucket?: string
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string | null
          version: number
        }
        Update: {
          blueprint_id?: string
          content_hash?: string | null
          file_name?: string
          id?: string
          mime_type?: string
          notes?: string | null
          org_id?: string
          revision?: string
          revision_date?: string | null
          size_bytes?: number
          storage_bucket?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "blueprint_versions_blueprint_id_fkey"
            columns: ["blueprint_id"]
            isOneToOne: false
            referencedRelation: "blueprints"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprint_versions_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      blueprints: {
        Row: {
          created_at: string
          created_by: string | null
          current_version: number | null
          discipline: string | null
          drawing_number: string
          id: string
          job_id: string
          org_id: string
          status: string
          title: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          current_version?: number | null
          discipline?: string | null
          drawing_number: string
          id?: string
          job_id: string
          org_id: string
          status?: string
          title: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          current_version?: number | null
          discipline?: string | null
          drawing_number?: string
          id?: string
          job_id?: string
          org_id?: string
          status?: string
          title?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "blueprints_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprints_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprints_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprints_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      briefing_dismissals: {
        Row: {
          created_at: string
          dismissed_on: string
          id: string
          item_key: string
          org_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          dismissed_on?: string
          id?: string
          item_key: string
          org_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          dismissed_on?: string
          id?: string
          item_key?: string
          org_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "briefing_dismissals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefing_dismissals_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_connections: {
        Row: {
          access_token: string | null
          connected_at: string | null
          connected_by: string | null
          created_at: string
          external_account_id: string | null
          id: string
          last_error: string | null
          last_sync_at: string | null
          org_id: string
          provider: string
          refresh_token: string | null
          status: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          external_account_id?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          org_id: string
          provider: string
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          external_account_id?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          org_id?: string
          provider?: string
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_event_links: {
        Row: {
          connection_id: string
          created_at: string
          etag: string | null
          external_event_id: string
          id: string
          last_synced_at: string | null
          local_id: string
          local_kind: string
          org_id: string
          updated_at: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          etag?: string | null
          external_event_id: string
          id?: string
          last_synced_at?: string | null
          local_id: string
          local_kind: string
          org_id: string
          updated_at?: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          etag?: string | null
          external_event_id?: string
          id?: string
          last_synced_at?: string | null
          local_id?: string
          local_kind?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_event_links_connection_fk"
            columns: ["connection_id", "org_id"]
            isOneToOne: false
            referencedRelation: "calendar_connections"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "calendar_event_links_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_pulled_events: {
        Row: {
          connection_id: string
          created_at: string
          ends_at: string | null
          etag: string | null
          external_event_id: string
          ical_uid: string | null
          id: string
          is_all_day: boolean
          is_busy: boolean
          is_crewflow_origin: boolean
          location: string | null
          org_id: string
          provider_updated_at: string | null
          starts_at: string | null
          status: string | null
          summary: string | null
          updated_at: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          ends_at?: string | null
          etag?: string | null
          external_event_id: string
          ical_uid?: string | null
          id?: string
          is_all_day?: boolean
          is_busy?: boolean
          is_crewflow_origin?: boolean
          location?: string | null
          org_id: string
          provider_updated_at?: string | null
          starts_at?: string | null
          status?: string | null
          summary?: string | null
          updated_at?: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          ends_at?: string | null
          etag?: string | null
          external_event_id?: string
          ical_uid?: string | null
          id?: string
          is_all_day?: boolean
          is_busy?: boolean
          is_crewflow_origin?: boolean
          location?: string | null
          org_id?: string
          provider_updated_at?: string | null
          starts_at?: string | null
          status?: string | null
          summary?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_pulled_events_connection_fk"
            columns: ["connection_id", "org_id"]
            isOneToOne: false
            referencedRelation: "calendar_connections"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "calendar_pulled_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_watch_channels: {
        Row: {
          channel_id: string
          connection_id: string
          created_at: string
          expiration: string | null
          id: string
          last_error: string | null
          last_notified_at: string | null
          last_synced_at: string | null
          org_id: string
          provider: string
          resource_id: string | null
          status: string
          sync_token: string | null
          updated_at: string
          verification_token: string | null
        }
        Insert: {
          channel_id: string
          connection_id: string
          created_at?: string
          expiration?: string | null
          id?: string
          last_error?: string | null
          last_notified_at?: string | null
          last_synced_at?: string | null
          org_id: string
          provider: string
          resource_id?: string | null
          status?: string
          sync_token?: string | null
          updated_at?: string
          verification_token?: string | null
        }
        Update: {
          channel_id?: string
          connection_id?: string
          created_at?: string
          expiration?: string | null
          id?: string
          last_error?: string | null
          last_notified_at?: string | null
          last_synced_at?: string | null
          org_id?: string
          provider?: string
          resource_id?: string | null
          status?: string
          sync_token?: string | null
          updated_at?: string
          verification_token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "calendar_watch_channels_connection_fk"
            columns: ["connection_id", "org_id"]
            isOneToOne: false
            referencedRelation: "calendar_connections"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "calendar_watch_channels_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      call_events: {
        Row: {
          call_id: string
          created_at: string
          event_type: string
          id: string
          occurred_at: string
          org_id: string
          payload: Json | null
          provider_event_id: string | null
        }
        Insert: {
          call_id: string
          created_at?: string
          event_type: string
          id?: string
          occurred_at?: string
          org_id: string
          payload?: Json | null
          provider_event_id?: string | null
        }
        Update: {
          call_id?: string
          created_at?: string
          event_type?: string
          id?: string
          occurred_at?: string
          org_id?: string
          payload?: Json | null
          provider_event_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_events_call_org_fkey"
            columns: ["call_id", "org_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id", "org_id"]
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
      cis_bill_details: {
        Row: {
          citb_levy_amount: number
          created_at: string
          created_by: string | null
          finance_id: string
          materials_amount: number
          notes: string | null
          org_id: string
          reverse_charge_vat_rate: number | null
          supplier_id: string
          updated_at: string
          updated_by: string | null
          vat_treatment: string
        }
        Insert: {
          citb_levy_amount?: number
          created_at?: string
          created_by?: string | null
          finance_id: string
          materials_amount?: number
          notes?: string | null
          org_id: string
          reverse_charge_vat_rate?: number | null
          supplier_id: string
          updated_at?: string
          updated_by?: string | null
          vat_treatment?: string
        }
        Update: {
          citb_levy_amount?: number
          created_at?: string
          created_by?: string | null
          finance_id?: string
          materials_amount?: number
          notes?: string | null
          org_id?: string
          reverse_charge_vat_rate?: number | null
          supplier_id?: string
          updated_at?: string
          updated_by?: string | null
          vat_treatment?: string
        }
        Relationships: [
          {
            foreignKeyName: "cis_bill_details_bill_fk"
            columns: ["finance_id", "org_id", "supplier_id"]
            isOneToOne: false
            referencedRelation: "finances"
            referencedColumns: ["id", "org_id", "supplier_id"]
          },
          {
            foreignKeyName: "cis_bill_details_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_bill_details_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_bill_details_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      cis_contractor_profiles: {
        Row: {
          accounts_office_reference: string | null
          contractor_utr: string | null
          created_at: string
          created_by: string | null
          employer_paye_reference: string
          legal_name: string
          org_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          accounts_office_reference?: string | null
          contractor_utr?: string | null
          created_at?: string
          created_by?: string | null
          employer_paye_reference: string
          legal_name: string
          org_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          accounts_office_reference?: string | null
          contractor_utr?: string | null
          created_at?: string
          created_by?: string | null
          employer_paye_reference?: string
          legal_name?: string
          org_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cis_contractor_profiles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_contractor_profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_contractor_profiles_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      cis_monthly_return_lines: {
        Row: {
          cis_status: string | null
          created_at: string
          deduction_amount: number
          deduction_rate: number | null
          gross_amount: number
          id: string
          materials_amount: number
          org_id: string
          payment_count: number
          rate_is_uniform: boolean
          return_id: string
          subcontractor_name: string
          subcontractor_utr_masked: string | null
          supplier_id: string
          verification_number: string | null
          verification_number_required: boolean
        }
        Insert: {
          cis_status?: string | null
          created_at?: string
          deduction_amount: number
          deduction_rate?: number | null
          gross_amount: number
          id?: string
          materials_amount: number
          org_id: string
          payment_count: number
          rate_is_uniform: boolean
          return_id: string
          subcontractor_name: string
          subcontractor_utr_masked?: string | null
          supplier_id: string
          verification_number?: string | null
          verification_number_required: boolean
        }
        Update: {
          cis_status?: string | null
          created_at?: string
          deduction_amount?: number
          deduction_rate?: number | null
          gross_amount?: number
          id?: string
          materials_amount?: number
          org_id?: string
          payment_count?: number
          rate_is_uniform?: boolean
          return_id?: string
          subcontractor_name?: string
          subcontractor_utr_masked?: string | null
          supplier_id?: string
          verification_number?: string | null
          verification_number_required?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "cis_monthly_return_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_monthly_return_lines_return_id_fkey"
            columns: ["return_id"]
            isOneToOne: false
            referencedRelation: "cis_monthly_returns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_monthly_return_lines_supplier_fk"
            columns: ["supplier_id", "org_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      cis_monthly_returns: {
        Row: {
          accounts_office_reference: string | null
          content_hash: string
          contractor_name: string
          contractor_paye_reference: string
          created_at: string
          exported_at: string | null
          exported_by: string | null
          id: string
          is_nil: boolean
          ledger_fingerprint: string
          org_id: string
          payment_count: number
          prepared_at: string
          prepared_by: string | null
          return_due_on: string | null
          status: string
          subcontractor_count: number
          superseded_at: string | null
          superseded_by: string | null
          supersedes_id: string | null
          tax_month_end: string
          tax_month_start: string
          total_deduction: number
          total_gross: number
          total_materials: number
          updated_at: string
        }
        Insert: {
          accounts_office_reference?: string | null
          content_hash: string
          contractor_name: string
          contractor_paye_reference: string
          created_at?: string
          exported_at?: string | null
          exported_by?: string | null
          id?: string
          is_nil: boolean
          ledger_fingerprint: string
          org_id: string
          payment_count: number
          prepared_at?: string
          prepared_by?: string | null
          return_due_on?: string | null
          status?: string
          subcontractor_count: number
          superseded_at?: string | null
          superseded_by?: string | null
          supersedes_id?: string | null
          tax_month_end: string
          tax_month_start: string
          total_deduction: number
          total_gross: number
          total_materials: number
          updated_at?: string
        }
        Update: {
          accounts_office_reference?: string | null
          content_hash?: string
          contractor_name?: string
          contractor_paye_reference?: string
          created_at?: string
          exported_at?: string | null
          exported_by?: string | null
          id?: string
          is_nil?: boolean
          ledger_fingerprint?: string
          org_id?: string
          payment_count?: number
          prepared_at?: string
          prepared_by?: string | null
          return_due_on?: string | null
          status?: string
          subcontractor_count?: number
          superseded_at?: string | null
          superseded_by?: string | null
          supersedes_id?: string | null
          tax_month_end?: string
          tax_month_start?: string
          total_deduction?: number
          total_gross?: number
          total_materials?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cis_monthly_returns_exported_by_fkey"
            columns: ["exported_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_monthly_returns_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_monthly_returns_prepared_by_fkey"
            columns: ["prepared_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_monthly_returns_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_monthly_returns_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "cis_monthly_returns"
            referencedColumns: ["id"]
          },
        ]
      }
      cis_payment_snapshots: {
        Row: {
          cis_basis: number
          cis_deduction: number
          cis_gross_payment: number
          cis_status: string
          citb_total: number
          created_at: string
          deduction_rate: number
          legal_name: string
          materials_total: number
          org_id: string
          payment_id: string
          supplier_id: string
          tax_month_end: string
          tax_month_start: string
          utr_masked: string | null
          verification_expires_at: string | null
          verification_reference: string | null
          verified_at: string | null
        }
        Insert: {
          cis_basis: number
          cis_deduction: number
          cis_gross_payment: number
          cis_status: string
          citb_total: number
          created_at?: string
          deduction_rate: number
          legal_name: string
          materials_total: number
          org_id: string
          payment_id: string
          supplier_id: string
          tax_month_end: string
          tax_month_start: string
          utr_masked?: string | null
          verification_expires_at?: string | null
          verification_reference?: string | null
          verified_at?: string | null
        }
        Update: {
          cis_basis?: number
          cis_deduction?: number
          cis_gross_payment?: number
          cis_status?: string
          citb_total?: number
          created_at?: string
          deduction_rate?: number
          legal_name?: string
          materials_total?: number
          org_id?: string
          payment_id?: string
          supplier_id?: string
          tax_month_end?: string
          tax_month_start?: string
          utr_masked?: string | null
          verification_expires_at?: string | null
          verification_reference?: string | null
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cis_payment_snapshots_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_payment_snapshots_payment_fk"
            columns: ["payment_id", "org_id", "supplier_id"]
            isOneToOne: false
            referencedRelation: "supplier_payments"
            referencedColumns: ["id", "org_id", "supplier_id"]
          },
        ]
      }
      cis_statement_payments: {
        Row: {
          cis_deduction: number
          cis_gross_payment: number
          cis_status: string
          created_at: string
          deduction_rate: number
          id: string
          materials_total: number
          org_id: string
          paid_on: string
          payment_id: string
          statement_id: string
          supplier_id: string
        }
        Insert: {
          cis_deduction: number
          cis_gross_payment: number
          cis_status: string
          created_at?: string
          deduction_rate: number
          id?: string
          materials_total: number
          org_id: string
          paid_on: string
          payment_id: string
          statement_id: string
          supplier_id: string
        }
        Update: {
          cis_deduction?: number
          cis_gross_payment?: number
          cis_status?: string
          created_at?: string
          deduction_rate?: number
          id?: string
          materials_total?: number
          org_id?: string
          paid_on?: string
          payment_id?: string
          statement_id?: string
          supplier_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cis_statement_payments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_statement_payments_payment_fk"
            columns: ["payment_id", "org_id", "supplier_id"]
            isOneToOne: false
            referencedRelation: "supplier_payments"
            referencedColumns: ["id", "org_id", "supplier_id"]
          },
          {
            foreignKeyName: "cis_statement_payments_statement_id_fkey"
            columns: ["statement_id"]
            isOneToOne: false
            referencedRelation: "cis_statements"
            referencedColumns: ["id"]
          },
        ]
      }
      cis_statements: {
        Row: {
          cis_status: string | null
          content_hash: string
          contractor_name: string
          contractor_paye_reference: string
          created_at: string
          deduction_amount: number
          deduction_rate: number | null
          gross_amount: number
          id: string
          is_statutory: boolean
          issued_at: string
          issued_by: string | null
          issued_on: string
          ledger_fingerprint: string
          materials_amount: number
          org_id: string
          payment_count: number
          rate_is_uniform: boolean
          sequence_no: number
          statement_due_on: string | null
          statement_number: string
          status: string
          subcontractor_name: string
          subcontractor_utr_masked: string | null
          superseded_at: string | null
          superseded_by: string | null
          supersedes_id: string | null
          supplier_id: string
          tax_month_end: string
          tax_month_start: string
          updated_at: string
          verification_number: string | null
          verification_number_required: boolean
          withdraw_reason: string | null
          withdrawn_at: string | null
          withdrawn_by: string | null
        }
        Insert: {
          cis_status?: string | null
          content_hash: string
          contractor_name: string
          contractor_paye_reference: string
          created_at?: string
          deduction_amount: number
          deduction_rate?: number | null
          gross_amount: number
          id?: string
          is_statutory: boolean
          issued_at?: string
          issued_by?: string | null
          issued_on?: string
          ledger_fingerprint: string
          materials_amount: number
          org_id: string
          payment_count: number
          rate_is_uniform: boolean
          sequence_no: number
          statement_due_on?: string | null
          statement_number: string
          status?: string
          subcontractor_name: string
          subcontractor_utr_masked?: string | null
          superseded_at?: string | null
          superseded_by?: string | null
          supersedes_id?: string | null
          supplier_id: string
          tax_month_end: string
          tax_month_start: string
          updated_at?: string
          verification_number?: string | null
          verification_number_required: boolean
          withdraw_reason?: string | null
          withdrawn_at?: string | null
          withdrawn_by?: string | null
        }
        Update: {
          cis_status?: string | null
          content_hash?: string
          contractor_name?: string
          contractor_paye_reference?: string
          created_at?: string
          deduction_amount?: number
          deduction_rate?: number | null
          gross_amount?: number
          id?: string
          is_statutory?: boolean
          issued_at?: string
          issued_by?: string | null
          issued_on?: string
          ledger_fingerprint?: string
          materials_amount?: number
          org_id?: string
          payment_count?: number
          rate_is_uniform?: boolean
          sequence_no?: number
          statement_due_on?: string | null
          statement_number?: string
          status?: string
          subcontractor_name?: string
          subcontractor_utr_masked?: string | null
          superseded_at?: string | null
          superseded_by?: string | null
          supersedes_id?: string | null
          supplier_id?: string
          tax_month_end?: string
          tax_month_start?: string
          updated_at?: string
          verification_number?: string | null
          verification_number_required?: boolean
          withdraw_reason?: string | null
          withdrawn_at?: string | null
          withdrawn_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cis_statements_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_statements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_statements_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_statements_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "cis_statements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_statements_supplier_fk"
            columns: ["supplier_id", "org_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "cis_statements_withdrawn_by_fkey"
            columns: ["withdrawn_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      cis_subcontractors: {
        Row: {
          cis_status: string
          company_number: string | null
          created_at: string
          created_by: string | null
          deduction_rate: number | null
          legal_name: string
          notes: string | null
          org_id: string
          subcontractor_type: string | null
          supplier_id: string
          trading_name: string | null
          updated_at: string
          updated_by: string | null
          utr: string | null
          vat_number: string | null
          vat_registered: boolean
          verification_expires_at: string | null
          verification_reference: string | null
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          cis_status?: string
          company_number?: string | null
          created_at?: string
          created_by?: string | null
          deduction_rate?: number | null
          legal_name: string
          notes?: string | null
          org_id: string
          subcontractor_type?: string | null
          supplier_id: string
          trading_name?: string | null
          updated_at?: string
          updated_by?: string | null
          utr?: string | null
          vat_number?: string | null
          vat_registered?: boolean
          verification_expires_at?: string | null
          verification_reference?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          cis_status?: string
          company_number?: string | null
          created_at?: string
          created_by?: string | null
          deduction_rate?: number | null
          legal_name?: string
          notes?: string | null
          org_id?: string
          subcontractor_type?: string | null
          supplier_id?: string
          trading_name?: string | null
          updated_at?: string
          updated_by?: string | null
          utr?: string | null
          vat_number?: string | null
          vat_registered?: boolean
          verification_expires_at?: string | null
          verification_reference?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cis_subcontractors_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_subcontractors_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_subcontractors_supplier_fk"
            columns: ["supplier_id", "org_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "cis_subcontractors_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cis_subcontractors_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      comm_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          message_id: string | null
          occurred_at: string
          org_id: string | null
          payload: Json | null
          provider: string
          provider_event_id: string
          provider_message_id: string | null
          recipient: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          message_id?: string | null
          occurred_at?: string
          org_id?: string | null
          payload?: Json | null
          provider?: string
          provider_event_id: string
          provider_message_id?: string | null
          recipient?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          message_id?: string | null
          occurred_at?: string
          org_id?: string | null
          payload?: Json | null
          provider?: string
          provider_event_id?: string
          provider_message_id?: string | null
          recipient?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comm_events_message_org_fkey"
            columns: ["message_id", "org_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "comm_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      completion_certificates: {
        Row: {
          certificate_number: string
          completion_date: string
          content: Json
          created_at: string
          customer_id: string | null
          customer_notified_at: string | null
          id: string
          issued_at: string | null
          issued_by: string | null
          job_id: string | null
          org_id: string
          portal_published_at: string | null
          portal_published_by: string | null
          portal_withdrawn_at: string | null
          prepared_by: string | null
          revision: number
          snapshot: Json | null
          status: string
          supersedes_id: string | null
          updated_at: string
        }
        Insert: {
          certificate_number: string
          completion_date: string
          content?: Json
          created_at?: string
          customer_id?: string | null
          customer_notified_at?: string | null
          id?: string
          issued_at?: string | null
          issued_by?: string | null
          job_id?: string | null
          org_id: string
          portal_published_at?: string | null
          portal_published_by?: string | null
          portal_withdrawn_at?: string | null
          prepared_by?: string | null
          revision?: number
          snapshot?: Json | null
          status?: string
          supersedes_id?: string | null
          updated_at?: string
        }
        Update: {
          certificate_number?: string
          completion_date?: string
          content?: Json
          created_at?: string
          customer_id?: string | null
          customer_notified_at?: string | null
          id?: string
          issued_at?: string | null
          issued_by?: string | null
          job_id?: string | null
          org_id?: string
          portal_published_at?: string | null
          portal_published_by?: string | null
          portal_withdrawn_at?: string | null
          prepared_by?: string | null
          revision?: number
          snapshot?: Json | null
          status?: string
          supersedes_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "completion_certificates_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_certificates_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_certificates_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_certificates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_certificates_portal_published_by_fkey"
            columns: ["portal_published_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_certificates_prepared_by_fkey"
            columns: ["prepared_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_certificates_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "completion_certificates"
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
          contact_name: string | null
          contact_ref: string | null
          created_at: string
          customer_id: string | null
          external_id: string | null
          id: string
          last_message_at: string | null
          lead_id: string | null
          org_id: string
          status: string
          subject: string | null
          updated_at: string
        }
        Insert: {
          channel: string
          contact_name?: string | null
          contact_ref?: string | null
          created_at?: string
          customer_id?: string | null
          external_id?: string | null
          id?: string
          last_message_at?: string | null
          lead_id?: string | null
          org_id: string
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Update: {
          channel?: string
          contact_name?: string | null
          contact_ref?: string | null
          created_at?: string
          customer_id?: string | null
          external_id?: string | null
          id?: string
          last_message_at?: string | null
          lead_id?: string | null
          org_id?: string
          status?: string
          subject?: string | null
          updated_at?: string
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
            foreignKeyName: "conversations_customer_org_fk"
            columns: ["customer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "org_id"]
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
      customer_contacts: {
        Row: {
          created_at: string
          created_by: string | null
          customer_id: string
          email: string | null
          id: string
          name: string
          notes: string | null
          org_id: string
          phone: string | null
          portal_access_enabled: boolean
          portal_token: string | null
          portal_token_expires_at: string | null
          portal_token_last_used_at: string | null
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          customer_id: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          org_id: string
          phone?: string | null
          portal_access_enabled?: boolean
          portal_token?: string | null
          portal_token_expires_at?: string | null
          portal_token_last_used_at?: string | null
          role?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          customer_id?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          org_id?: string
          phone?: string | null
          portal_access_enabled?: boolean
          portal_token?: string | null
          portal_token_expires_at?: string | null
          portal_token_last_used_at?: string | null
          role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_contacts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_contacts_customer_org_fkey"
            columns: ["customer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "customer_contacts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_portal_preferences: {
        Row: {
          contact_notes: string | null
          created_at: string
          customer_id: string
          org_id: string
          preferred_channel: string
          updated_at: string
        }
        Insert: {
          contact_notes?: string | null
          created_at?: string
          customer_id: string
          org_id: string
          preferred_channel?: string
          updated_at?: string
        }
        Update: {
          contact_notes?: string | null
          created_at?: string
          customer_id?: string
          org_id?: string
          preferred_channel?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_portal_preferences_customer_org_fk"
            columns: ["customer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "customer_portal_preferences_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          company_number: string | null
          country: string
          county: string | null
          created_at: string
          customer_type: string
          email: string | null
          id: string
          name: string
          notes: string | null
          org_id: string
          parent_customer_id: string | null
          phone: string | null
          portal_token: string | null
          portal_token_expires_at: string | null
          portal_token_last_used_at: string | null
          postcode: string | null
          updated_at: string
          vat_number: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          company_number?: string | null
          country?: string
          county?: string | null
          created_at?: string
          customer_type?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          org_id: string
          parent_customer_id?: string | null
          phone?: string | null
          portal_token?: string | null
          portal_token_expires_at?: string | null
          portal_token_last_used_at?: string | null
          postcode?: string | null
          updated_at?: string
          vat_number?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          company_number?: string | null
          country?: string
          county?: string | null
          created_at?: string
          customer_type?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          org_id?: string
          parent_customer_id?: string | null
          phone?: string | null
          portal_token?: string | null
          portal_token_expires_at?: string | null
          portal_token_last_used_at?: string | null
          postcode?: string | null
          updated_at?: string
          vat_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_parent_org_fkey"
            columns: ["parent_customer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "org_id"]
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
      delay_events: {
        Row: {
          category: string
          client_write_key: string | null
          created_at: string
          created_by: string | null
          description: string
          diary_entry_id: string | null
          ended_on: string | null
          id: string
          job_id: string
          last_offline_write_key: string | null
          offline_authored_at: string | null
          org_id: string
          recorded_at: string | null
          recorded_by: string | null
          started_on: string
          status: string
          updated_at: string
          variation_quote_id: string | null
          weather_district: string | null
          withdrawn_at: string | null
          withdrawn_by: string | null
          working_days_lost: number | null
        }
        Insert: {
          category: string
          client_write_key?: string | null
          created_at?: string
          created_by?: string | null
          description: string
          diary_entry_id?: string | null
          ended_on?: string | null
          id?: string
          job_id: string
          last_offline_write_key?: string | null
          offline_authored_at?: string | null
          org_id: string
          recorded_at?: string | null
          recorded_by?: string | null
          started_on: string
          status?: string
          updated_at?: string
          variation_quote_id?: string | null
          weather_district?: string | null
          withdrawn_at?: string | null
          withdrawn_by?: string | null
          working_days_lost?: number | null
        }
        Update: {
          category?: string
          client_write_key?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          diary_entry_id?: string | null
          ended_on?: string | null
          id?: string
          job_id?: string
          last_offline_write_key?: string | null
          offline_authored_at?: string | null
          org_id?: string
          recorded_at?: string | null
          recorded_by?: string | null
          started_on?: string
          status?: string
          updated_at?: string
          variation_quote_id?: string | null
          weather_district?: string | null
          withdrawn_at?: string | null
          withdrawn_by?: string | null
          working_days_lost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "delay_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delay_events_diary_fkey"
            columns: ["diary_entry_id", "org_id"]
            isOneToOne: false
            referencedRelation: "site_diary_entries"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "delay_events_job_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "delay_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delay_events_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delay_events_variation_fkey"
            columns: ["variation_quote_id", "org_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "delay_events_withdrawn_by_fkey"
            columns: ["withdrawn_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
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
      email_inbound_routes: {
        Row: {
          active: boolean
          created_at: string
          id: string
          inbound_address: string
          org_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          inbound_address: string
          org_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          inbound_address?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_inbound_routes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      email_webhook_events: {
        Row: {
          claimed_at: string | null
          created_at: string
          error_message: string | null
          event_key: string
          from_address: string | null
          id: string
          org_id: string | null
          payload: Json
          processed_at: string | null
          provider_message_id: string
          to_address: string | null
        }
        Insert: {
          claimed_at?: string | null
          created_at?: string
          error_message?: string | null
          event_key: string
          from_address?: string | null
          id?: string
          org_id?: string | null
          payload: Json
          processed_at?: string | null
          provider_message_id: string
          to_address?: string | null
        }
        Update: {
          claimed_at?: string | null
          created_at?: string
          error_message?: string | null
          event_key?: string
          from_address?: string | null
          id?: string
          org_id?: string | null
          payload?: Json
          processed_at?: string | null
          provider_message_id?: string
          to_address?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_webhook_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_budgets: {
        Row: {
          amount_pence: number
          category: string
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          org_id: string
          period_type: string
          updated_at: string
        }
        Insert: {
          amount_pence: number
          category: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          org_id: string
          period_type?: string
          updated_at?: string
        }
        Update: {
          amount_pence?: number
          category?: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          org_id?: string
          period_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_budgets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_budgets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
          bill_date: string | null
          category: string | null
          created_at: string
          currency: string
          id: string
          job_id: string | null
          notes: string | null
          org_id: string
          purchase_order_id: string | null
          receipt_url: string | null
          reference: string | null
          supplier_id: string | null
          updated_at: string
          vat_rate: number
          vat_total: number | null
        }
        Insert: {
          amount: number
          bill_date?: string | null
          category?: string | null
          created_at?: string
          currency?: string
          id?: string
          job_id?: string | null
          notes?: string | null
          org_id: string
          purchase_order_id?: string | null
          receipt_url?: string | null
          reference?: string | null
          supplier_id?: string | null
          updated_at?: string
          vat_rate?: number
          vat_total?: number | null
        }
        Update: {
          amount?: number
          bill_date?: string | null
          category?: string | null
          created_at?: string
          currency?: string
          id?: string
          job_id?: string | null
          notes?: string | null
          org_id?: string
          purchase_order_id?: string | null
          receipt_url?: string | null
          reference?: string | null
          supplier_id?: string | null
          updated_at?: string
          vat_rate?: number
          vat_total?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "finances_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "finances_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finances_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
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
      fleet_vehicles: {
        Row: {
          asset_id: string
          created_at: string
          created_by: string | null
          finance_agreement_ref: string | null
          finance_end_date: string | null
          finance_monthly_payment: number | null
          finance_provider_id: string | null
          finance_type: string
          first_registered_on: string | null
          fuel_type: string | null
          gross_weight_kg: number | null
          home_depot: string | null
          home_site_id: string | null
          mot_exempt: boolean
          odometer_miles: number | null
          odometer_recorded_at: string | null
          operational_status: string
          org_id: string
          updated_at: string
          variant: string | null
          vehicle_class: string | null
          vin: string | null
          year_of_manufacture: number | null
        }
        Insert: {
          asset_id: string
          created_at?: string
          created_by?: string | null
          finance_agreement_ref?: string | null
          finance_end_date?: string | null
          finance_monthly_payment?: number | null
          finance_provider_id?: string | null
          finance_type?: string
          first_registered_on?: string | null
          fuel_type?: string | null
          gross_weight_kg?: number | null
          home_depot?: string | null
          home_site_id?: string | null
          mot_exempt?: boolean
          odometer_miles?: number | null
          odometer_recorded_at?: string | null
          operational_status?: string
          org_id: string
          updated_at?: string
          variant?: string | null
          vehicle_class?: string | null
          vin?: string | null
          year_of_manufacture?: number | null
        }
        Update: {
          asset_id?: string
          created_at?: string
          created_by?: string | null
          finance_agreement_ref?: string | null
          finance_end_date?: string | null
          finance_monthly_payment?: number | null
          finance_provider_id?: string | null
          finance_type?: string
          first_registered_on?: string | null
          fuel_type?: string | null
          gross_weight_kg?: number | null
          home_depot?: string | null
          home_site_id?: string | null
          mot_exempt?: boolean
          odometer_miles?: number | null
          odometer_recorded_at?: string | null
          operational_status?: string
          org_id?: string
          updated_at?: string
          variant?: string | null
          vehicle_class?: string | null
          vin?: string | null
          year_of_manufacture?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fleet_vehicles_asset_org_fk"
            columns: ["asset_id", "org_id"]
            isOneToOne: true
            referencedRelation: "assets"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "fleet_vehicles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fleet_vehicles_finance_provider_id_fkey"
            columns: ["finance_provider_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fleet_vehicles_home_site_id_fkey"
            columns: ["home_site_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fleet_vehicles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      gdpr_erasure_log: {
        Row: {
          anonymised_rows: number
          anonymised_tables: number
          confirmed_slug: string
          created_at: string
          deleted_rows: number
          deleted_tables: number
          id: string
          note: string | null
          org_id: string
          requested_by: string | null
          status: string
          storage_objects_deleted: number
        }
        Insert: {
          anonymised_rows?: number
          anonymised_tables?: number
          confirmed_slug: string
          created_at?: string
          deleted_rows?: number
          deleted_tables?: number
          id?: string
          note?: string | null
          org_id: string
          requested_by?: string | null
          status?: string
          storage_objects_deleted?: number
        }
        Update: {
          anonymised_rows?: number
          anonymised_tables?: number
          confirmed_slug?: string
          created_at?: string
          deleted_rows?: number
          deleted_tables?: number
          id?: string
          note?: string | null
          org_id?: string
          requested_by?: string | null
          status?: string
          storage_objects_deleted?: number
        }
        Relationships: [
          {
            foreignKeyName: "gdpr_erasure_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gdpr_erasure_log_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      gdpr_export_log: {
        Row: {
          created_at: string
          created_by: string | null
          format: string
          id: string
          note: string | null
          org_id: string
          row_count: number
          status: string
          table_count: number
          truncated: boolean
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          format: string
          id?: string
          note?: string | null
          org_id: string
          row_count?: number
          status?: string
          table_count?: number
          truncated?: boolean
        }
        Update: {
          created_at?: string
          created_by?: string | null
          format?: string
          id?: string
          note?: string | null
          org_id?: string
          row_count?: number
          status?: string
          table_count?: number
          truncated?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "gdpr_export_log_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gdpr_export_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      goods_received_lines: {
        Row: {
          created_at: string
          goods_received_note_id: string
          id: string
          notes: string | null
          org_id: string
          purchase_order_line_item_id: string
          qty_received: number
        }
        Insert: {
          created_at?: string
          goods_received_note_id: string
          id?: string
          notes?: string | null
          org_id: string
          purchase_order_line_item_id: string
          qty_received: number
        }
        Update: {
          created_at?: string
          goods_received_note_id?: string
          id?: string
          notes?: string | null
          org_id?: string
          purchase_order_line_item_id?: string
          qty_received?: number
        }
        Relationships: [
          {
            foreignKeyName: "goods_received_lines_grn_org_fkey"
            columns: ["goods_received_note_id", "org_id"]
            isOneToOne: false
            referencedRelation: "goods_received_notes"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "goods_received_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_received_lines_po_line_org_fkey"
            columns: ["purchase_order_line_item_id", "org_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_line_items"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      goods_received_notes: {
        Row: {
          created_at: string
          created_by: string | null
          delivery_date: string
          delivery_location: string | null
          delivery_note_reference: string | null
          id: string
          notes: string | null
          number: string
          org_id: string
          posted_at: string | null
          posted_by: string | null
          purchase_order_id: string
          received_by: string | null
          status: string
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          delivery_date?: string
          delivery_location?: string | null
          delivery_note_reference?: string | null
          id?: string
          notes?: string | null
          number: string
          org_id: string
          posted_at?: string | null
          posted_by?: string | null
          purchase_order_id: string
          received_by?: string | null
          status?: string
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          delivery_date?: string
          delivery_location?: string | null
          delivery_note_reference?: string | null
          id?: string
          notes?: string | null
          number?: string
          org_id?: string
          posted_at?: string | null
          posted_by?: string | null
          purchase_order_id?: string
          received_by?: string | null
          status?: string
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "goods_received_notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_received_notes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_received_notes_po_org_fkey"
            columns: ["purchase_order_id", "org_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "goods_received_notes_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_received_notes_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_received_notes_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "users"
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
      help_articles: {
        Row: {
          active: boolean
          body: string
          category: string
          created_at: string
          id: string
          keywords: string[]
          slug: string
          sort_order: number
          summary: string
          title: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          body: string
          category: string
          created_at?: string
          id?: string
          keywords?: string[]
          slug: string
          sort_order?: number
          summary?: string
          title: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          body?: string
          category?: string
          created_at?: string
          id?: string
          keywords?: string[]
          slug?: string
          sort_order?: number
          summary?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      hmrc_connections: {
        Row: {
          access_token: string | null
          connected_at: string | null
          connected_by: string | null
          created_at: string
          gov_client_ids: Json
          hmrc_vrn: string | null
          id: string
          last_error: string | null
          last_sync_at: string | null
          org_id: string
          provider: string
          refresh_token: string | null
          status: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          gov_client_ids?: Json
          hmrc_vrn?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          org_id: string
          provider?: string
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          gov_client_ids?: Json
          hmrc_vrn?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          org_id?: string
          provider?: string
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hmrc_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmrc_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      hmrc_submissions: {
        Row: {
          connection_id: string
          created_at: string
          hmrc_charge_ref_number: string | null
          hmrc_form_bundle_number: string | null
          hmrc_payment_indicator: string | null
          hmrc_processing_date: string | null
          id: string
          kind: string
          org_id: string
          payload: Json
          period_key: string
          prepared_by: string | null
          status: string
          submit_error: string | null
          submitted_at: string | null
          submitted_by: string | null
        }
        Insert: {
          connection_id: string
          created_at?: string
          hmrc_charge_ref_number?: string | null
          hmrc_form_bundle_number?: string | null
          hmrc_payment_indicator?: string | null
          hmrc_processing_date?: string | null
          id?: string
          kind: string
          org_id: string
          payload: Json
          period_key: string
          prepared_by?: string | null
          status?: string
          submit_error?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
        }
        Update: {
          connection_id?: string
          created_at?: string
          hmrc_charge_ref_number?: string | null
          hmrc_form_bundle_number?: string | null
          hmrc_payment_indicator?: string | null
          hmrc_processing_date?: string | null
          id?: string
          kind?: string
          org_id?: string
          payload?: Json
          period_key?: string
          prepared_by?: string | null
          status?: string
          submit_error?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hmrc_submissions_conn_fk"
            columns: ["connection_id", "org_id"]
            isOneToOne: false
            referencedRelation: "hmrc_connections"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "hmrc_submissions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmrc_submissions_prepared_by_fkey"
            columns: ["prepared_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hmrc_submissions_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      holiday_entitlements: {
        Row: {
          accrual_method: string
          annual_allowance_days: number
          carry_over_max_days: number
          created_at: string
          id: string
          leave_year_start_day: number
          leave_year_start_month: number
          org_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          accrual_method?: string
          annual_allowance_days?: number
          carry_over_max_days?: number
          created_at?: string
          id?: string
          leave_year_start_day?: number
          leave_year_start_month?: number
          org_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          accrual_method?: string
          annual_allowance_days?: number
          carry_over_max_days?: number
          created_at?: string
          id?: string
          leave_year_start_day?: number
          leave_year_start_month?: number
          org_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "holiday_entitlements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "holiday_entitlements_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
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
      hq_ai_schedule_runs: {
        Row: {
          cadence_key: string
          detail: Json
          fired_at: string
          id: string
          occurrence: string
          outcome: string
          schedule_id: string
        }
        Insert: {
          cadence_key: string
          detail?: Json
          fired_at?: string
          id?: string
          occurrence: string
          outcome?: string
          schedule_id: string
        }
        Update: {
          cadence_key?: string
          detail?: Json
          fired_at?: string
          id?: string
          occurrence?: string
          outcome?: string
          schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_ai_schedule_runs_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "hq_ai_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_ai_schedules: {
        Row: {
          cadence_key: string
          created_at: string
          created_by: string | null
          cron_expr: string
          description: string | null
          enabled: boolean
          id: string
          last_run_at: string | null
          next_run_at: string | null
          updated_at: string
        }
        Insert: {
          cadence_key: string
          created_at?: string
          created_by?: string | null
          cron_expr: string
          description?: string | null
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          next_run_at?: string | null
          updated_at?: string
        }
        Update: {
          cadence_key?: string
          created_at?: string
          created_by?: string | null
          cron_expr?: string
          description?: string | null
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          next_run_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      hq_ai_task_stage_events: {
        Row: {
          created_at: string
          from_stage: string | null
          id: string
          status: string
          task_id: string
          task_type: string
          to_stage: string
        }
        Insert: {
          created_at?: string
          from_stage?: string | null
          id?: string
          status: string
          task_id: string
          task_type: string
          to_stage: string
        }
        Update: {
          created_at?: string
          from_stage?: string | null
          id?: string
          status?: string
          task_id?: string
          task_type?: string
          to_stage?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_ai_task_stage_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "hq_ai_tasks"
            referencedColumns: ["id"]
          },
        ]
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
          pipeline_stage: string | null
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
          pipeline_stage?: string | null
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
          pipeline_stage?: string | null
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
      hq_application_records: {
        Row: {
          action_id: string
          applied_at: string
          approval_id: string | null
          approver_email: string | null
          approver_id: string | null
          attempts: number
          correlation_id: string
          error: string | null
          escalated: boolean
          id: number
          key: string
          result: Json | null
          source: string
          status: string
          task_id: string | null
          tool_label: string
        }
        Insert: {
          action_id: string
          applied_at?: string
          approval_id?: string | null
          approver_email?: string | null
          approver_id?: string | null
          attempts?: number
          correlation_id: string
          error?: string | null
          escalated?: boolean
          id?: never
          key: string
          result?: Json | null
          source: string
          status: string
          task_id?: string | null
          tool_label: string
        }
        Update: {
          action_id?: string
          applied_at?: string
          approval_id?: string | null
          approver_email?: string | null
          approver_id?: string | null
          attempts?: number
          correlation_id?: string
          error?: string | null
          escalated?: boolean
          id?: never
          key?: string
          result?: Json | null
          source?: string
          status?: string
          task_id?: string | null
          tool_label?: string
        }
        Relationships: []
      }
      hq_apply_audit: {
        Row: {
          action_id: string
          correlation_id: string
          detail: string
          id: number
          path: string
          recorded_at: string
          stage: string
          steps: Json
          tool_label: string
        }
        Insert: {
          action_id: string
          correlation_id: string
          detail: string
          id?: never
          path: string
          recorded_at?: string
          stage: string
          steps?: Json
          tool_label: string
        }
        Update: {
          action_id?: string
          correlation_id?: string
          detail?: string
          id?: never
          path?: string
          recorded_at?: string
          stage?: string
          steps?: Json
          tool_label?: string
        }
        Relationships: []
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
      hq_ceo_briefings: {
        Row: {
          briefing_date: string
          correlation_id: string | null
          created_at: string
          generated_at: string
          headline: string
          id: number
          narrative: string
          signals: Json
          source: string
        }
        Insert: {
          briefing_date: string
          correlation_id?: string | null
          created_at?: string
          generated_at?: string
          headline: string
          id?: never
          narrative: string
          signals?: Json
          source?: string
        }
        Update: {
          briefing_date?: string
          correlation_id?: string | null
          created_at?: string
          generated_at?: string
          headline?: string
          id?: never
          narrative?: string
          signals?: Json
          source?: string
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
      hq_competitor_notes: {
        Row: {
          captured_by: string | null
          category: string | null
          competitor_name: string
          created_at: string
          detail: string
          headline: string
          id: string
          importance: string
          memory_type: string
          source_url: string | null
          status: string
          updated_at: string
        }
        Insert: {
          captured_by?: string | null
          category?: string | null
          competitor_name: string
          created_at?: string
          detail?: string
          headline: string
          id?: string
          importance?: string
          memory_type?: string
          source_url?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          captured_by?: string | null
          category?: string | null
          competitor_name?: string
          created_at?: string
          detail?: string
          headline?: string
          id?: string
          importance?: string
          memory_type?: string
          source_url?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_competitor_notes_memory_type_fkey"
            columns: ["memory_type"]
            isOneToOne: false
            referencedRelation: "hq_memory_types"
            referencedColumns: ["slug"]
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
      hq_decision_events: {
        Row: {
          actor_email: string | null
          actor_id: string | null
          created_at: string
          decision_id: string
          delay_until: string | null
          delegate_to: string | null
          event_type: string
          from_status: string | null
          id: string
          reason: string | null
          to_status: string
        }
        Insert: {
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          decision_id: string
          delay_until?: string | null
          delegate_to?: string | null
          event_type: string
          from_status?: string | null
          id?: string
          reason?: string | null
          to_status: string
        }
        Update: {
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          decision_id?: string
          delay_until?: string | null
          delegate_to?: string | null
          event_type?: string
          from_status?: string | null
          id?: string
          reason?: string | null
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_decision_events_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "hq_decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_decisions: {
        Row: {
          ai_debate: Json
          business_impact: string | null
          created_at: string
          created_by: string | null
          decided_at: string | null
          decided_by: string | null
          decision_reason: string | null
          delay_until: string | null
          delegate_to: string | null
          demand: string | null
          engineering_cost: string | null
          id: string
          problem: string | null
          recommendation: string | null
          revenue_impact: string | null
          risk: string | null
          source: string
          source_signal_key: string | null
          status: string
          timeline: string | null
          title: string
          updated_at: string
        }
        Insert: {
          ai_debate?: Json
          business_impact?: string | null
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_reason?: string | null
          delay_until?: string | null
          delegate_to?: string | null
          demand?: string | null
          engineering_cost?: string | null
          id?: string
          problem?: string | null
          recommendation?: string | null
          revenue_impact?: string | null
          risk?: string | null
          source?: string
          source_signal_key?: string | null
          status?: string
          timeline?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          ai_debate?: Json
          business_impact?: string | null
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_reason?: string | null
          delay_until?: string | null
          delegate_to?: string | null
          demand?: string | null
          engineering_cost?: string | null
          id?: string
          problem?: string | null
          recommendation?: string | null
          revenue_impact?: string | null
          risk?: string | null
          source?: string
          source_signal_key?: string | null
          status?: string
          timeline?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_decisions_delegate_to_fkey"
            columns: ["delegate_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
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
      hq_saga_events: {
        Row: {
          actor_email: string | null
          actor_id: string | null
          created_at: string
          detail: Json
          event_type: string
          from_status: string | null
          id: string
          saga_id: string
          step_id: string | null
          to_status: string | null
        }
        Insert: {
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          detail?: Json
          event_type: string
          from_status?: string | null
          id?: string
          saga_id: string
          step_id?: string | null
          to_status?: string | null
        }
        Update: {
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          detail?: Json
          event_type?: string
          from_status?: string | null
          id?: string
          saga_id?: string
          step_id?: string | null
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hq_saga_events_saga_id_fkey"
            columns: ["saga_id"]
            isOneToOne: false
            referencedRelation: "hq_workflow_sagas"
            referencedColumns: ["id"]
          },
        ]
      }
      hq_saga_steps: {
        Row: {
          created_at: string
          department: string | null
          depends_on_ordinal: number | null
          hq_ai_task_id: string | null
          id: string
          ordinal: number
          role: string | null
          saga_id: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          department?: string | null
          depends_on_ordinal?: number | null
          hq_ai_task_id?: string | null
          id?: string
          ordinal: number
          role?: string | null
          saga_id: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          department?: string | null
          depends_on_ordinal?: number | null
          hq_ai_task_id?: string | null
          id?: string
          ordinal?: number
          role?: string | null
          saga_id?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_saga_steps_hq_ai_task_id_fkey"
            columns: ["hq_ai_task_id"]
            isOneToOne: false
            referencedRelation: "hq_ai_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hq_saga_steps_saga_id_fkey"
            columns: ["saga_id"]
            isOneToOne: false
            referencedRelation: "hq_workflow_sagas"
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
      hq_workflow_sagas: {
        Row: {
          created_at: string
          created_by: string | null
          decision_id: string | null
          id: string
          status: string
          template_key: string | null
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          decision_id?: string | null
          id?: string
          status?: string
          template_key?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          decision_id?: string | null
          id?: string
          status?: string
          template_key?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hq_workflow_sagas_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "hq_decisions"
            referencedColumns: ["id"]
          },
        ]
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
          has_media: boolean
          id: string
          job_type: string | null
          lead_id: string | null
          org_id: string
          postcode: string | null
          processed_at: string | null
          provider_message_id: string | null
          provider_timestamp: string | null
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
          has_media?: boolean
          id?: string
          job_type?: string | null
          lead_id?: string | null
          org_id: string
          postcode?: string | null
          processed_at?: string | null
          provider_message_id?: string | null
          provider_timestamp?: string | null
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
          has_media?: boolean
          id?: string
          job_type?: string | null
          lead_id?: string | null
          org_id?: string
          postcode?: string | null
          processed_at?: string | null
          provider_message_id?: string | null
          provider_timestamp?: string | null
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
      inspection_plan_items: {
        Row: {
          acceptance_criteria: string
          control_point: string
          created_at: string
          id: string
          inspection_method: string | null
          inspection_test_plan_id: string
          is_hold_point: boolean
          item_number: number
          org_id: string
          required: boolean
          specification_ref: string | null
          title: string
        }
        Insert: {
          acceptance_criteria: string
          control_point?: string
          created_at?: string
          id?: string
          inspection_method?: string | null
          inspection_test_plan_id: string
          is_hold_point?: boolean
          item_number: number
          org_id: string
          required?: boolean
          specification_ref?: string | null
          title: string
        }
        Update: {
          acceptance_criteria?: string
          control_point?: string
          created_at?: string
          id?: string
          inspection_method?: string | null
          inspection_test_plan_id?: string
          is_hold_point?: boolean
          item_number?: number
          org_id?: string
          required?: boolean
          specification_ref?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "ipi_parent_org_fk"
            columns: ["inspection_test_plan_id", "org_id"]
            isOneToOne: false
            referencedRelation: "inspection_test_plans"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "ipi_parent_org_fk"
            columns: ["inspection_test_plan_id", "org_id"]
            isOneToOne: false
            referencedRelation: "works_quality_plan_status"
            referencedColumns: ["plan_id", "org_id"]
          },
        ]
      }
      inspection_plan_template_items: {
        Row: {
          acceptance_criteria: string
          control_point: string
          created_at: string
          id: string
          inspection_method: string | null
          is_hold_point: boolean
          item_number: number
          org_id: string
          required: boolean
          specification_ref: string | null
          template_id: string
          title: string
        }
        Insert: {
          acceptance_criteria: string
          control_point?: string
          created_at?: string
          id?: string
          inspection_method?: string | null
          is_hold_point?: boolean
          item_number: number
          org_id: string
          required?: boolean
          specification_ref?: string | null
          template_id: string
          title: string
        }
        Update: {
          acceptance_criteria?: string
          control_point?: string
          created_at?: string
          id?: string
          inspection_method?: string | null
          is_hold_point?: boolean
          item_number?: number
          org_id?: string
          required?: boolean
          specification_ref?: string | null
          template_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "ipti_template_org_fk"
            columns: ["template_id", "org_id"]
            isOneToOne: false
            referencedRelation: "inspection_plan_templates"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      inspection_plan_templates: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
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
          created_at?: string
          created_by?: string | null
          description?: string | null
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
          created_at?: string
          created_by?: string | null
          description?: string | null
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
            foreignKeyName: "inspection_plan_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_plan_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_plan_templates_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ipt_supersedes_org_fk"
            columns: ["supersedes_id", "org_id"]
            isOneToOne: false
            referencedRelation: "inspection_plan_templates"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      inspection_signoffs: {
        Row: {
          comments: string | null
          created_at: string
          hold_point_breach: boolean
          id: string
          inspected_at: string
          inspected_by: string
          inspection_plan_item_id: string
          open_hold_item_number: number | null
          org_id: string
          plan_version: string
          recorded_at: string
          result: string
          signed_name: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
          witness_invitation_id: string | null
          witness_name: string | null
          witness_organisation: string | null
        }
        Insert: {
          comments?: string | null
          created_at?: string
          hold_point_breach?: boolean
          id?: string
          inspected_at?: string
          inspected_by: string
          inspection_plan_item_id: string
          open_hold_item_number?: number | null
          org_id: string
          plan_version: string
          recorded_at?: string
          result: string
          signed_name: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
          witness_invitation_id?: string | null
          witness_name?: string | null
          witness_organisation?: string | null
        }
        Update: {
          comments?: string | null
          created_at?: string
          hold_point_breach?: boolean
          id?: string
          inspected_at?: string
          inspected_by?: string
          inspection_plan_item_id?: string
          open_hold_item_number?: number | null
          org_id?: string
          plan_version?: string
          recorded_at?: string
          result?: string
          signed_name?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
          witness_invitation_id?: string | null
          witness_name?: string | null
          witness_organisation?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inspection_signoffs_inspected_by_fkey"
            columns: ["inspected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_signoffs_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "isg_item_org_fk"
            columns: ["inspection_plan_item_id", "org_id"]
            isOneToOne: false
            referencedRelation: "inspection_plan_items"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "isg_witness_invitation_org_fk"
            columns: ["witness_invitation_id", "org_id"]
            isOneToOne: false
            referencedRelation: "inspection_witness_invitations"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      inspection_test_plans: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          issued_at: string | null
          issued_by: string | null
          job_id: string | null
          location: string | null
          notes: string | null
          org_id: string
          plan_date: string | null
          prepared_by: string | null
          reference: string | null
          revision_number: number
          root_plan_id: string
          specification_ref: string | null
          status: string
          supersedes_id: string | null
          title: string
          updated_at: string
          work_package: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          issued_at?: string | null
          issued_by?: string | null
          job_id?: string | null
          location?: string | null
          notes?: string | null
          org_id: string
          plan_date?: string | null
          prepared_by?: string | null
          reference?: string | null
          revision_number?: number
          root_plan_id: string
          specification_ref?: string | null
          status?: string
          supersedes_id?: string | null
          title: string
          updated_at?: string
          work_package: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          issued_at?: string | null
          issued_by?: string | null
          job_id?: string | null
          location?: string | null
          notes?: string | null
          org_id?: string
          plan_date?: string | null
          prepared_by?: string | null
          reference?: string | null
          revision_number?: number
          root_plan_id?: string
          specification_ref?: string | null
          status?: string
          supersedes_id?: string | null
          title?: string
          updated_at?: string
          work_package?: string
        }
        Relationships: [
          {
            foreignKeyName: "inspection_test_plans_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_test_plans_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_test_plans_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_test_plans_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_test_plans_prepared_by_fkey"
            columns: ["prepared_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "itp_supersedes_org_fkey"
            columns: ["supersedes_id", "org_id"]
            isOneToOne: false
            referencedRelation: "inspection_test_plans"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "itp_supersedes_org_fkey"
            columns: ["supersedes_id", "org_id"]
            isOneToOne: false
            referencedRelation: "works_quality_plan_status"
            referencedColumns: ["plan_id", "org_id"]
          },
        ]
      }
      inspection_witness_invitations: {
        Row: {
          attendance_recorded_at: string | null
          attendance_recorded_by: string | null
          created_at: string
          id: string
          inspection_plan_item_id: string
          invited_by: string | null
          org_id: string
          scheduled_for: string | null
          status: string
          updated_at: string
          witness_email: string | null
          witness_name: string
          witness_organisation: string
        }
        Insert: {
          attendance_recorded_at?: string | null
          attendance_recorded_by?: string | null
          created_at?: string
          id?: string
          inspection_plan_item_id: string
          invited_by?: string | null
          org_id: string
          scheduled_for?: string | null
          status?: string
          updated_at?: string
          witness_email?: string | null
          witness_name: string
          witness_organisation: string
        }
        Update: {
          attendance_recorded_at?: string | null
          attendance_recorded_by?: string | null
          created_at?: string
          id?: string
          inspection_plan_item_id?: string
          invited_by?: string | null
          org_id?: string
          scheduled_for?: string | null
          status?: string
          updated_at?: string
          witness_email?: string | null
          witness_name?: string
          witness_organisation?: string
        }
        Relationships: [
          {
            foreignKeyName: "inspection_witness_invitations_attendance_recorded_by_fkey"
            columns: ["attendance_recorded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_witness_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "iwi_item_org_fk"
            columns: ["inspection_plan_item_id", "org_id"]
            isOneToOne: false
            referencedRelation: "inspection_plan_items"
            referencedColumns: ["id", "org_id"]
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
      invoice_payment_intents: {
        Row: {
          amount: number
          created_at: string
          currency: string
          customer_id: string | null
          id: string
          invoice_id: string
          invoice_payment_id: string | null
          last_error: string | null
          org_id: string
          settled_event_id: string | null
          status: string
          stripe_account_id: string
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          customer_id?: string | null
          id?: string
          invoice_id: string
          invoice_payment_id?: string | null
          last_error?: string | null
          org_id: string
          settled_event_id?: string | null
          status?: string
          stripe_account_id: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          customer_id?: string | null
          id?: string
          invoice_id?: string
          invoice_payment_id?: string | null
          last_error?: string | null
          org_id?: string
          settled_event_id?: string | null
          status?: string
          stripe_account_id?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_payment_intents_customer_org_fkey"
            columns: ["customer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "invoice_payment_intents_invoice_org_fkey"
            columns: ["invoice_id", "org_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "invoice_payment_intents_invoice_payment_id_fkey"
            columns: ["invoice_payment_id"]
            isOneToOne: true
            referencedRelation: "invoice_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_payment_intents_org_id_fkey"
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
          payment_id: string | null
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
          payment_id?: string | null
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
          payment_id?: string | null
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
          {
            foreignKeyName: "invoice_payments_payment_org_fkey"
            columns: ["payment_id", "org_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "org_id"]
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
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
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
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
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
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
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
            foreignKeyName: "invoices_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
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
      job_billing_plans: {
        Row: {
          basis_amount: number
          created_at: string
          created_by: string | null
          id: string
          job_id: string
          notes: string | null
          org_id: string
          status: string
          structure: Database["public"]["Enums"]["billing_plan_structure"]
          updated_at: string
        }
        Insert: {
          basis_amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          job_id: string
          notes?: string | null
          org_id: string
          status?: string
          structure?: Database["public"]["Enums"]["billing_plan_structure"]
          updated_at?: string
        }
        Update: {
          basis_amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string
          notes?: string | null
          org_id?: string
          status?: string
          structure?: Database["public"]["Enums"]["billing_plan_structure"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_billing_plans_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_billing_plans_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_billing_plans_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_billing_stages: {
        Row: {
          amount: number
          basis: Database["public"]["Enums"]["billing_stage_basis"]
          created_at: string
          created_by: string | null
          due_date: string | null
          id: string
          invoice_id: string | null
          job_id: string
          kind: Database["public"]["Enums"]["billing_stage_kind"]
          milestone: string | null
          name: string
          org_id: string
          percent: number | null
          plan_id: string
          retention_applies: boolean
          sequence: number
          updated_at: string
          vat_rate: number
        }
        Insert: {
          amount?: number
          basis?: Database["public"]["Enums"]["billing_stage_basis"]
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          id?: string
          invoice_id?: string | null
          job_id: string
          kind?: Database["public"]["Enums"]["billing_stage_kind"]
          milestone?: string | null
          name: string
          org_id: string
          percent?: number | null
          plan_id: string
          retention_applies?: boolean
          sequence?: number
          updated_at?: string
          vat_rate?: number
        }
        Update: {
          amount?: number
          basis?: Database["public"]["Enums"]["billing_stage_basis"]
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          id?: string
          invoice_id?: string | null
          job_id?: string
          kind?: Database["public"]["Enums"]["billing_stage_kind"]
          milestone?: string | null
          name?: string
          org_id?: string
          percent?: number | null
          plan_id?: string
          retention_applies?: boolean
          sequence?: number
          updated_at?: string
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "job_billing_stages_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_billing_stages_invoice_fk"
            columns: ["invoice_id", "org_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_billing_stages_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_billing_stages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_billing_stages_plan_fk"
            columns: ["plan_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_billing_plans"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      job_budgets: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          job_id: string
          labour_cost: number | null
          materials_cost: number | null
          misc_cost: number | null
          note: string | null
          org_id: string
          revision: number
          subcontractors_cost: number | null
          superseded_at: string | null
          target_margin_pct: number | null
          total_cost: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          job_id: string
          labour_cost?: number | null
          materials_cost?: number | null
          misc_cost?: number | null
          note?: string | null
          org_id: string
          revision?: number
          subcontractors_cost?: number | null
          superseded_at?: string | null
          target_margin_pct?: number | null
          total_cost?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string
          labour_cost?: number | null
          materials_cost?: number | null
          misc_cost?: number | null
          note?: string | null
          org_id?: string
          revision?: number
          subcontractors_cost?: number | null
          superseded_at?: string | null
          target_margin_pct?: number | null
          total_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "job_budgets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_budgets_job_fk"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_budgets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_checklists: {
        Row: {
          assigned_to: string | null
          created_at: string
          created_by: string | null
          done_at: string | null
          done_by: string | null
          due_on: string | null
          id: string
          is_done: boolean
          job_id: string
          label: string
          org_id: string
          requires_photo: boolean
          sort: number
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          created_by?: string | null
          done_at?: string | null
          done_by?: string | null
          due_on?: string | null
          id?: string
          is_done?: boolean
          job_id: string
          label: string
          org_id: string
          requires_photo?: boolean
          sort: number
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          created_by?: string | null
          done_at?: string | null
          done_by?: string | null
          due_on?: string | null
          id?: string
          is_done?: boolean
          job_id?: string
          label?: string
          org_id?: string
          requires_photo?: boolean
          sort?: number
        }
        Relationships: [
          {
            foreignKeyName: "job_checklists_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_checklists_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_checklists_done_by_fkey"
            columns: ["done_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_checklists_job_fk"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_checklists_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
      job_milestone_dependencies: {
        Row: {
          baseline_id: string
          created_at: string
          created_by: string | null
          depends_on_milestone_id: string
          id: string
          milestone_id: string
          org_id: string
        }
        Insert: {
          baseline_id: string
          created_at?: string
          created_by?: string | null
          depends_on_milestone_id: string
          id?: string
          milestone_id: string
          org_id: string
        }
        Update: {
          baseline_id?: string
          created_at?: string
          created_by?: string | null
          depends_on_milestone_id?: string
          id?: string
          milestone_id?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_milestone_dependencies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_milestone_dependencies_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_milestone_deps_baseline_fk"
            columns: ["baseline_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_programme_baselines"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_milestone_deps_predecessor_fk"
            columns: ["depends_on_milestone_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_milestones"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_milestone_deps_successor_fk"
            columns: ["milestone_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_milestones"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      job_milestones: {
        Row: {
          baseline_id: string
          customer_visible: boolean
          id: string
          org_id: string
          planned_end: string
          planned_start: string | null
          sort: number
          title: string
          weight: number | null
        }
        Insert: {
          baseline_id: string
          customer_visible?: boolean
          id?: string
          org_id: string
          planned_end: string
          planned_start?: string | null
          sort: number
          title: string
          weight?: number | null
        }
        Update: {
          baseline_id?: string
          customer_visible?: boolean
          id?: string
          org_id?: string
          planned_end?: string
          planned_start?: string | null
          sort?: number
          title?: string
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "job_milestones_baseline_fk"
            columns: ["baseline_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_programme_baselines"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_milestones_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_programme_baselines: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          job_id: string
          note: string | null
          org_id: string
          planned_end: string
          planned_start: string
          revision: number
          superseded_at: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          job_id: string
          note?: string | null
          org_id: string
          planned_end: string
          planned_start: string
          revision?: number
          superseded_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string
          note?: string | null
          org_id?: string
          planned_end?: string
          planned_start?: string
          revision?: number
          superseded_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_programme_baselines_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_programme_baselines_job_fk"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_programme_baselines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_progress_observations: {
        Row: {
          created_at: string
          id: string
          job_id: string
          note: string | null
          observed_on: string
          org_id: string
          percent: number
          recorded_by: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          job_id: string
          note?: string | null
          observed_on?: string
          org_id: string
          percent: number
          recorded_by?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          job_id?: string
          note?: string | null
          observed_on?: string
          org_id?: string
          percent?: number
          recorded_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_progress_observations_job_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_progress_observations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_progress_observations_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      job_template_checklist_items: {
        Row: {
          id: string
          label: string
          org_id: string
          requires_photo: boolean
          sort: number
          template_id: string
        }
        Insert: {
          id?: string
          label: string
          org_id: string
          requires_photo?: boolean
          sort: number
          template_id: string
        }
        Update: {
          id?: string
          label?: string
          org_id?: string
          requires_photo?: boolean
          sort?: number
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_template_checklist_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_template_checklist_template_fk"
            columns: ["template_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_templates"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      job_template_milestones: {
        Row: {
          customer_visible: boolean
          id: string
          offset_end_days: number
          offset_start_days: number | null
          org_id: string
          sort: number
          template_id: string
          title: string
          weight: number | null
        }
        Insert: {
          customer_visible?: boolean
          id?: string
          offset_end_days: number
          offset_start_days?: number | null
          org_id: string
          sort: number
          template_id: string
          title: string
          weight?: number | null
        }
        Update: {
          customer_visible?: boolean
          id?: string
          offset_end_days?: number
          offset_start_days?: number | null
          org_id?: string
          sort?: number
          template_id?: string
          title?: string
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "job_template_milestones_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_template_milestones_template_fk"
            columns: ["template_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_templates"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      job_templates: {
        Row: {
          created_at: string
          created_by: string | null
          default_status: string | null
          description: string | null
          id: string
          is_active: boolean
          job_type: string | null
          name: string
          org_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          default_status?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          job_type?: string | null
          name: string
          org_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          default_status?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          job_type?: string | null
          name?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_valuation_variations: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          id: string
          org_id: string
          valuation_id: string
          variation_quote_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          id?: string
          org_id: string
          valuation_id: string
          variation_quote_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          org_id?: string
          valuation_id?: string
          variation_quote_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_valuation_variations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_valuation_variations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_valuation_variations_quote_org_fkey"
            columns: ["variation_quote_id", "org_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_valuation_variations_valuation_org_fkey"
            columns: ["valuation_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_valuations"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      job_valuations: {
        Row: {
          certified_at: string | null
          certified_by: string | null
          created_at: string
          created_by: string | null
          deductions: number
          gross_valuation: number | null
          id: string
          invoice_id: string | null
          job_id: string
          materials_on_site: number
          net_certified_this: number | null
          notes: string | null
          org_id: string
          period_end: string | null
          period_start: string | null
          previous_certified_gross: number | null
          retention_percent: number | null
          sequence: number
          status: string
          updated_at: string
          valuation_date: string
          variations_total: number | null
          vat_rate: number
          work_completed_to_date: number
        }
        Insert: {
          certified_at?: string | null
          certified_by?: string | null
          created_at?: string
          created_by?: string | null
          deductions?: number
          gross_valuation?: number | null
          id?: string
          invoice_id?: string | null
          job_id: string
          materials_on_site?: number
          net_certified_this?: number | null
          notes?: string | null
          org_id: string
          period_end?: string | null
          period_start?: string | null
          previous_certified_gross?: number | null
          retention_percent?: number | null
          sequence: number
          status?: string
          updated_at?: string
          valuation_date?: string
          variations_total?: number | null
          vat_rate?: number
          work_completed_to_date?: number
        }
        Update: {
          certified_at?: string | null
          certified_by?: string | null
          created_at?: string
          created_by?: string | null
          deductions?: number
          gross_valuation?: number | null
          id?: string
          invoice_id?: string | null
          job_id?: string
          materials_on_site?: number
          net_certified_this?: number | null
          notes?: string | null
          org_id?: string
          period_end?: string | null
          period_start?: string | null
          previous_certified_gross?: number | null
          retention_percent?: number | null
          sequence?: number
          status?: string
          updated_at?: string
          valuation_date?: string
          variations_total?: number | null
          vat_rate?: number
          work_completed_to_date?: number
        }
        Relationships: [
          {
            foreignKeyName: "job_valuations_certified_by_fkey"
            columns: ["certified_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_valuations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_valuations_invoice_org_fkey"
            columns: ["invoice_id", "org_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_valuations_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_valuations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_warranties: {
        Row: {
          cover: string
          created_at: string
          created_by: string | null
          exclusions: string | null
          id: string
          job_id: string
          kind: string
          org_id: string
          period_months: number
          portal_published_at: string | null
          portal_published_by: string | null
          portal_withdrawn_at: string | null
          provider: string | null
          reference: string | null
          service_interval_months: number | null
          service_notes: string | null
          start_basis: string
          status: string
          title: string
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          cover: string
          created_at?: string
          created_by?: string | null
          exclusions?: string | null
          id?: string
          job_id: string
          kind?: string
          org_id: string
          period_months: number
          portal_published_at?: string | null
          portal_published_by?: string | null
          portal_withdrawn_at?: string | null
          provider?: string | null
          reference?: string | null
          service_interval_months?: number | null
          service_notes?: string | null
          start_basis?: string
          status?: string
          title: string
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          cover?: string
          created_at?: string
          created_by?: string | null
          exclusions?: string | null
          id?: string
          job_id?: string
          kind?: string
          org_id?: string
          period_months?: number
          portal_published_at?: string | null
          portal_published_by?: string | null
          portal_withdrawn_at?: string | null
          provider?: string | null
          reference?: string | null
          service_interval_months?: number | null
          service_notes?: string | null
          start_basis?: string
          status?: string
          title?: string
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_warranties_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_warranties_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "job_warranties_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_warranties_portal_published_by_fkey"
            columns: ["portal_published_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_warranties_voided_by_fkey"
            columns: ["voided_by"]
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
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          customer_id: string | null
          defects_liability_months: number
          id: string
          notes: string | null
          org_id: string
          photos: string[]
          practical_completion_date: string | null
          recurring: Json | null
          required_qualifications: string[]
          retention_first_release_pct: number
          retention_first_reminded_at: string | null
          retention_percent: number
          retention_second_reminded_at: string | null
          scheduled_date: string | null
          scheduled_end_date: string | null
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
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          customer_id?: string | null
          defects_liability_months?: number
          id?: string
          notes?: string | null
          org_id: string
          photos?: string[]
          practical_completion_date?: string | null
          recurring?: Json | null
          required_qualifications?: string[]
          retention_first_release_pct?: number
          retention_first_reminded_at?: string | null
          retention_percent?: number
          retention_second_reminded_at?: string | null
          scheduled_date?: string | null
          scheduled_end_date?: string | null
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
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          customer_id?: string | null
          defects_liability_months?: number
          id?: string
          notes?: string | null
          org_id?: string
          photos?: string[]
          practical_completion_date?: string | null
          recurring?: Json | null
          required_qualifications?: string[]
          retention_first_release_pct?: number
          retention_first_reminded_at?: string | null
          retention_percent?: number
          retention_second_reminded_at?: string | null
          scheduled_date?: string | null
          scheduled_end_date?: string | null
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
            foreignKeyName: "jobs_customer_org_fkey"
            columns: ["customer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "org_id"]
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
          lead_score: number | null
          lead_score_band: string | null
          lead_score_factors: Json | null
          lead_score_updated_at: string | null
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
          lead_score?: number | null
          lead_score_band?: string | null
          lead_score_factors?: Json | null
          lead_score_updated_at?: string | null
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
          lead_score?: number | null
          lead_score_band?: string | null
          lead_score_factors?: Json | null
          lead_score_updated_at?: string | null
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
            foreignKeyName: "leads_customer_org_fkey"
            columns: ["customer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "org_id"]
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
      maintenance_reminder_log: {
        Row: {
          channel: string
          created_at: string
          due_date: string
          id: string
          job_id: string
          kind: string
          org_id: string
          provider_message_id: string | null
          scheduled_for: string
          sent_at: string | null
          status: string
          updated_at: string
          warranty_id: string
        }
        Insert: {
          channel?: string
          created_at?: string
          due_date: string
          id?: string
          job_id: string
          kind?: string
          org_id: string
          provider_message_id?: string | null
          scheduled_for: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          warranty_id: string
        }
        Update: {
          channel?: string
          created_at?: string
          due_date?: string
          id?: string
          job_id?: string
          kind?: string
          org_id?: string
          provider_message_id?: string | null
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          warranty_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_reminder_log_job_fk"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "maintenance_reminder_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_reminder_log_warranty_fk"
            columns: ["warranty_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_warranties"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      marketplace_entitlements: {
        Row: {
          created_at: string
          granted_at: string
          id: string
          install_id: string
          org_id: string
          revoked_at: string | null
          scope: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          granted_at?: string
          id?: string
          install_id: string
          org_id: string
          revoked_at?: string | null
          scope: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          granted_at?: string
          id?: string
          install_id?: string
          org_id?: string
          revoked_at?: string | null
          scope?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_entitlements_install_org_fkey"
            columns: ["install_id", "org_id"]
            isOneToOne: false
            referencedRelation: "marketplace_installs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "marketplace_entitlements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      marketplace_installs: {
        Row: {
          api_key_id: string
          config: Json
          consented_at: string
          consented_by: string | null
          consented_scopes: string[]
          created_at: string
          id: string
          installed_at: string
          listing_id: string
          org_id: string
          status: string
          uninstalled_at: string | null
          updated_at: string
          webhook_endpoint_id: string | null
        }
        Insert: {
          api_key_id: string
          config?: Json
          consented_at?: string
          consented_by?: string | null
          consented_scopes?: string[]
          created_at?: string
          id?: string
          installed_at?: string
          listing_id: string
          org_id: string
          status?: string
          uninstalled_at?: string | null
          updated_at?: string
          webhook_endpoint_id?: string | null
        }
        Update: {
          api_key_id?: string
          config?: Json
          consented_at?: string
          consented_by?: string | null
          consented_scopes?: string[]
          created_at?: string
          id?: string
          installed_at?: string
          listing_id?: string
          org_id?: string
          status?: string
          uninstalled_at?: string | null
          updated_at?: string
          webhook_endpoint_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_installs_consented_by_fkey"
            columns: ["consented_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketplace_installs_key_org_fkey"
            columns: ["api_key_id", "org_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "marketplace_installs_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "marketplace_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketplace_installs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketplace_installs_webhook_endpoint_id_fkey"
            columns: ["webhook_endpoint_id"]
            isOneToOne: false
            referencedRelation: "webhook_endpoints"
            referencedColumns: ["id"]
          },
        ]
      }
      marketplace_listings: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          logo_url: string | null
          name: string
          partner_id: string
          requested_scopes: string[]
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          short_description: string
          slug: string
          status: string
          submitted_at: string | null
          updated_at: string
          webhook_events: string[]
          webhook_url: string | null
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          logo_url?: string | null
          name: string
          partner_id: string
          requested_scopes?: string[]
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          short_description: string
          slug: string
          status?: string
          submitted_at?: string | null
          updated_at?: string
          webhook_events?: string[]
          webhook_url?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          logo_url?: string | null
          name?: string
          partner_id?: string
          requested_scopes?: string[]
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          short_description?: string
          slug?: string
          status?: string
          submitted_at?: string | null
          updated_at?: string
          webhook_events?: string[]
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_listings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketplace_listings_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "marketplace_partners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketplace_listings_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      marketplace_partners: {
        Row: {
          contact_email: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string
          org_id: string
          slug: string
          status: string
          updated_at: string
          website_url: string | null
        }
        Insert: {
          contact_email?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          org_id: string
          slug: string
          status?: string
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          contact_email?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          org_id?: string
          slug?: string
          status?: string
          updated_at?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_partners_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketplace_partners_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      material_request_lines: {
        Row: {
          created_at: string
          description: string
          id: string
          material_request_id: string
          org_id: string
          qty: number
          sort_order: number
          stock_item_id: string | null
          unit: string | null
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          material_request_id: string
          org_id: string
          qty: number
          sort_order?: number
          stock_item_id?: string | null
          unit?: string | null
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          material_request_id?: string
          org_id?: string
          qty?: number
          sort_order?: number
          stock_item_id?: string | null
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "material_request_lines_item_org_fkey"
            columns: ["stock_item_id", "org_id"]
            isOneToOne: false
            referencedRelation: "stock_items"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "material_request_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_request_lines_request_org_fkey"
            columns: ["material_request_id", "org_id"]
            isOneToOne: false
            referencedRelation: "material_requests"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      material_requests: {
        Row: {
          client_write_key: string | null
          created_at: string
          created_by: string | null
          decided_at: string | null
          decided_by: string | null
          id: string
          job_id: string | null
          needed_by: string | null
          notes: string | null
          number: string
          offline_authored_at: string | null
          org_id: string
          priority: string
          rejection_reason: string | null
          requested_by: string | null
          status: string
          submitted_at: string | null
          updated_at: string
        }
        Insert: {
          client_write_key?: string | null
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          job_id?: string | null
          needed_by?: string | null
          notes?: string | null
          number: string
          offline_authored_at?: string | null
          org_id: string
          priority?: string
          rejection_reason?: string | null
          requested_by?: string | null
          status?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Update: {
          client_write_key?: string | null
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          job_id?: string | null
          needed_by?: string | null
          notes?: string | null
          number?: string
          offline_authored_at?: string | null
          org_id?: string
          priority?: string
          rejection_reason?: string | null
          requested_by?: string | null
          status?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_requests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_requests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_requests_requested_by_fkey"
            columns: ["requested_by"]
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
      merchant_catalogue_items: {
        Row: {
          connection_id: string
          created_at: string
          currency: string
          description: string
          effective_date: string | null
          id: string
          imported_at: string
          org_id: string
          pack_size: string | null
          provider: string
          sku: string
          unit: string | null
          unit_price_pence: number
          updated_at: string
          vat_code: string | null
        }
        Insert: {
          connection_id: string
          created_at?: string
          currency?: string
          description?: string
          effective_date?: string | null
          id?: string
          imported_at?: string
          org_id: string
          pack_size?: string | null
          provider: string
          sku: string
          unit?: string | null
          unit_price_pence: number
          updated_at?: string
          vat_code?: string | null
        }
        Update: {
          connection_id?: string
          created_at?: string
          currency?: string
          description?: string
          effective_date?: string | null
          id?: string
          imported_at?: string
          org_id?: string
          pack_size?: string | null
          provider?: string
          sku?: string
          unit?: string | null
          unit_price_pence?: number
          updated_at?: string
          vat_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merchant_catalogue_items_connection_org_fk"
            columns: ["connection_id", "org_id"]
            isOneToOne: false
            referencedRelation: "merchant_connections"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "merchant_catalogue_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_connections: {
        Row: {
          account_secret: string | null
          connected_at: string | null
          connected_by: string | null
          created_at: string
          external_account_id: string | null
          id: string
          last_error: string | null
          last_sync_at: string | null
          org_id: string
          provider: string
          secret_expires_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          account_secret?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          external_account_id?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          org_id: string
          provider: string
          secret_expires_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          account_secret?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          external_account_id?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          org_id?: string
          provider?: string
          secret_expires_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_po_submissions: {
        Row: {
          connection_id: string
          created_at: string
          external_order_ref: string | null
          id: string
          org_id: string
          provider: string
          purchase_order_id: string
          request_format: string
          response_text: string | null
          status: string
          submitted_at: string | null
          submitted_by: string | null
        }
        Insert: {
          connection_id: string
          created_at?: string
          external_order_ref?: string | null
          id?: string
          org_id: string
          provider: string
          purchase_order_id: string
          request_format?: string
          response_text?: string | null
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
        }
        Update: {
          connection_id?: string
          created_at?: string
          external_order_ref?: string | null
          id?: string
          org_id?: string
          provider?: string
          purchase_order_id?: string
          request_format?: string
          response_text?: string | null
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merchant_po_submissions_connection_org_fk"
            columns: ["connection_id", "org_id"]
            isOneToOne: false
            referencedRelation: "merchant_connections"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "merchant_po_submissions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_po_submissions_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          auto_generated: boolean
          body: string | null
          channel: string | null
          conversation_id: string
          created_at: string
          created_by: string | null
          direction: string
          failure_reason: string | null
          from_addr: string | null
          id: string
          media_urls: string[] | null
          org_id: string
          provider_id: string | null
          status: string | null
          to_addr: string | null
        }
        Insert: {
          auto_generated?: boolean
          body?: string | null
          channel?: string | null
          conversation_id: string
          created_at?: string
          created_by?: string | null
          direction: string
          failure_reason?: string | null
          from_addr?: string | null
          id?: string
          media_urls?: string[] | null
          org_id: string
          provider_id?: string | null
          status?: string | null
          to_addr?: string | null
        }
        Update: {
          auto_generated?: boolean
          body?: string | null
          channel?: string | null
          conversation_id?: string
          created_at?: string
          created_by?: string | null
          direction?: string
          failure_reason?: string | null
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
            foreignKeyName: "messages_conversation_org_fk"
            columns: ["conversation_id", "org_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "messages_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
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
      mfa_recovery_codes: {
        Row: {
          code_hash: string
          created_at: string
          id: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          code_hash: string
          created_at?: string
          id?: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          code_hash?: string
          created_at?: string
          id?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
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
      ncr_corrective_actions: {
        Row: {
          assigned_to: string | null
          completed_at: string | null
          completion_comment: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision: string | null
          decision_reason: string | null
          description: string
          due_date: string | null
          id: string
          ncr_id: string
          org_id: string
          proposed_at: string
          proposed_by: string | null
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          completed_at?: string | null
          completion_comment?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision?: string | null
          decision_reason?: string | null
          description: string
          due_date?: string | null
          id?: string
          ncr_id: string
          org_id: string
          proposed_at?: string
          proposed_by?: string | null
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          completed_at?: string | null
          completion_comment?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision?: string | null
          decision_reason?: string | null
          description?: string
          due_date?: string | null
          id?: string
          ncr_id?: string
          org_id?: string
          proposed_at?: string
          proposed_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "nca_ncr_org_fk"
            columns: ["ncr_id", "org_id"]
            isOneToOne: false
            referencedRelation: "non_conformance_reports"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "ncr_corrective_actions_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ncr_corrective_actions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ncr_corrective_actions_proposed_by_fkey"
            columns: ["proposed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      non_conformance_reports: {
        Row: {
          closure_comment: string | null
          created_at: string
          description: string
          due_date: string | null
          id: string
          inspection_plan_item_id: string
          org_id: string
          raised_by: string
          reference: string
          responsible_subcontractor: string | null
          responsible_user_id: string | null
          severity: string
          source_signoff_id: string | null
          status: string
          title: string
          updated_at: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          closure_comment?: string | null
          created_at?: string
          description: string
          due_date?: string | null
          id?: string
          inspection_plan_item_id: string
          org_id: string
          raised_by: string
          reference: string
          responsible_subcontractor?: string | null
          responsible_user_id?: string | null
          severity: string
          source_signoff_id?: string | null
          status?: string
          title: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          closure_comment?: string | null
          created_at?: string
          description?: string
          due_date?: string | null
          id?: string
          inspection_plan_item_id?: string
          org_id?: string
          raised_by?: string
          reference?: string
          responsible_subcontractor?: string | null
          responsible_user_id?: string | null
          severity?: string
          source_signoff_id?: string | null
          status?: string
          title?: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ncr_item_org_fk"
            columns: ["inspection_plan_item_id", "org_id"]
            isOneToOne: false
            referencedRelation: "inspection_plan_items"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "ncr_source_signoff_org_fk"
            columns: ["source_signoff_id", "org_id"]
            isOneToOne: false
            referencedRelation: "inspection_signoffs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "non_conformance_reports_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "non_conformance_reports_responsible_user_id_fkey"
            columns: ["responsible_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "non_conformance_reports_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_digest_cursors: {
        Row: {
          cadence: string
          created_at: string
          last_sent_at: string
          org_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cadence: string
          created_at?: string
          last_sent_at?: string
          org_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cadence?: string
          created_at?: string
          last_sent_at?: string
          org_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_digest_cursors_org_id_fkey"
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
          cis_statement_key: string | null
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
          cis_statement_key?: string | null
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
          cis_statement_key?: string | null
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
      notification_preferences: {
        Row: {
          category: string
          created_at: string
          email_cadence: string
          email_enabled: boolean
          id: string
          in_app_enabled: boolean
          org_id: string
          push_enabled: boolean
          sms_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          email_cadence?: string
          email_enabled?: boolean
          id?: string
          in_app_enabled?: boolean
          org_id: string
          push_enabled?: boolean
          sms_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          email_cadence?: string
          email_enabled?: boolean
          id?: string
          in_app_enabled?: boolean
          org_id?: string
          push_enabled?: boolean
          sms_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
      org_payment_connections: {
        Row: {
          account_name: string | null
          charges_enabled: boolean
          connected_at: string | null
          connected_by: string | null
          created_at: string
          default_currency: string
          details_submitted: boolean
          id: string
          last_error: string | null
          last_synced_at: string | null
          org_id: string
          payouts_enabled: boolean
          provider: string
          status: string
          stripe_account_id: string | null
          updated_at: string
        }
        Insert: {
          account_name?: string | null
          charges_enabled?: boolean
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          default_currency?: string
          details_submitted?: boolean
          id?: string
          last_error?: string | null
          last_synced_at?: string | null
          org_id: string
          payouts_enabled?: boolean
          provider?: string
          status?: string
          stripe_account_id?: string | null
          updated_at?: string
        }
        Update: {
          account_name?: string | null
          charges_enabled?: boolean
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          default_currency?: string
          details_submitted?: boolean
          id?: string
          last_error?: string | null
          last_synced_at?: string | null
          org_id?: string
          payouts_enabled?: boolean
          provider?: string
          status?: string
          stripe_account_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_payment_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_payment_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_scim_config: {
        Row: {
          created_at: string
          created_by: string | null
          enabled: boolean
          id: string
          org_id: string
          token_hash: string | null
          token_minted_at: string | null
          token_prefix: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          org_id: string
          token_hash?: string | null
          token_minted_at?: string | null
          token_prefix?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          org_id?: string
          token_hash?: string | null
          token_minted_at?: string | null
          token_prefix?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_scim_config_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_scim_config_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_settings: {
        Row: {
          cis_default_rate: number
          created_at: string
          default_payment_terms_days: number
          default_vat_rate: number
          financial_year_start_month: number
          flat_rate_config: Json
          id: string
          org_id: string
          updated_at: string
          vat_scheme: string
          vat_stagger: string
          working_hours: Json
        }
        Insert: {
          cis_default_rate?: number
          created_at?: string
          default_payment_terms_days?: number
          default_vat_rate?: number
          financial_year_start_month?: number
          flat_rate_config?: Json
          id?: string
          org_id: string
          updated_at?: string
          vat_scheme?: string
          vat_stagger?: string
          working_hours?: Json
        }
        Update: {
          cis_default_rate?: number
          created_at?: string
          default_payment_terms_days?: number
          default_vat_rate?: number
          financial_year_start_month?: number
          flat_rate_config?: Json
          id?: string
          org_id?: string
          updated_at?: string
          vat_scheme?: string
          vat_stagger?: string
          working_hours?: Json
        }
        Relationships: [
          {
            foreignKeyName: "org_settings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_sso_config: {
        Row: {
          created_at: string
          created_by: string | null
          enabled: boolean
          id: string
          oidc_client_id: string | null
          oidc_client_secret_ciphertext: string | null
          oidc_discovery_url: string | null
          oidc_issuer: string | null
          org_id: string
          protocol: string
          saml_idp_entity_id: string | null
          saml_idp_sso_url: string | null
          saml_idp_x509_cert: string | null
          saml_name_id_format: string | null
          sp_entity_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          oidc_client_id?: string | null
          oidc_client_secret_ciphertext?: string | null
          oidc_discovery_url?: string | null
          oidc_issuer?: string | null
          org_id: string
          protocol: string
          saml_idp_entity_id?: string | null
          saml_idp_sso_url?: string | null
          saml_idp_x509_cert?: string | null
          saml_name_id_format?: string | null
          sp_entity_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          oidc_client_id?: string | null
          oidc_client_secret_ciphertext?: string | null
          oidc_discovery_url?: string | null
          oidc_issuer?: string | null
          org_id?: string
          protocol?: string
          saml_idp_entity_id?: string | null
          saml_idp_sso_url?: string | null
          saml_idp_x509_cert?: string | null
          saml_name_id_format?: string | null
          sp_entity_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_sso_config_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_sso_config_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          canceled_at: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          org_id: string
          plan_key: string
          status: string
          stripe_customer_id: string | null
          stripe_price_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          org_id: string
          plan_key?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          org_id?: string
          plan_key?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_subscriptions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
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
          locale: string
          logo_path: string | null
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
          phone_region: string
          plan: string
          rejection_reason: string | null
          require_mfa: boolean
          setup_fee_paid_at: string | null
          setup_fee_status: string
          slug: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          suspended_at: string | null
          tax_jurisdiction: string
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
          locale?: string
          logo_path?: string | null
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
          phone_region?: string
          plan?: string
          rejection_reason?: string | null
          require_mfa?: boolean
          setup_fee_paid_at?: string | null
          setup_fee_status?: string
          slug: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          suspended_at?: string | null
          tax_jurisdiction?: string
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
          locale?: string
          logo_path?: string | null
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
          phone_region?: string
          plan?: string
          rejection_reason?: string | null
          require_mfa?: boolean
          setup_fee_paid_at?: string | null
          setup_fee_status?: string
          slug?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          suspended_at?: string | null
          tax_jurisdiction?: string
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
      payments: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          customer_id: string | null
          id: string
          method: string
          notes: string | null
          org_id: string
          paid_at: string
          reference: string | null
          source: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          method?: string
          notes?: string | null
          org_id: string
          paid_at: string
          reference?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          method?: string
          notes?: string | null
          org_id?: string
          paid_at?: string
          reference?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_line_adjustments: {
        Row: {
          actor_id: string | null
          created_at: string
          field: string
          id: string
          new_gross_pay: number
          new_overtime_hours: number
          new_overtime_multiplier: number
          old_gross_pay: number
          old_overtime_hours: number
          old_overtime_multiplier: number
          org_id: string
          payroll_line_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          field?: string
          id?: string
          new_gross_pay?: number
          new_overtime_hours?: number
          new_overtime_multiplier?: number
          old_gross_pay?: number
          old_overtime_hours?: number
          old_overtime_multiplier?: number
          org_id: string
          payroll_line_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          field?: string
          id?: string
          new_gross_pay?: number
          new_overtime_hours?: number
          new_overtime_multiplier?: number
          old_gross_pay?: number
          old_overtime_hours?: number
          old_overtime_multiplier?: number
          org_id?: string
          payroll_line_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payroll_line_adjustments_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_line_adjustments_line_fk"
            columns: ["payroll_line_id", "org_id"]
            isOneToOne: false
            referencedRelation: "payroll_lines"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "payroll_line_adjustments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
          leave_hours: number
          leave_pay: number
          net_pay: number
          ni_estimate: number
          note: string | null
          org_id: string
          overtime_hours: number
          overtime_multiplier: number
          overtime_pay: number
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
          leave_hours?: number
          leave_pay?: number
          net_pay?: number
          ni_estimate?: number
          note?: string | null
          org_id: string
          overtime_hours?: number
          overtime_multiplier?: number
          overtime_pay?: number
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
          leave_hours?: number
          leave_pay?: number
          net_pay?: number
          ni_estimate?: number
          note?: string | null
          org_id?: string
          overtime_hours?: number
          overtime_multiplier?: number
          overtime_pay?: number
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
      payroll_tax_profiles: {
        Row: {
          created_at: string
          date_of_birth: string | null
          id: string
          ni_category: string
          org_id: string
          salary_sacrifice_annual_pence: number
          standard_hours_per_day: number | null
          student_loan_plan: string
          tax_region: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          date_of_birth?: string | null
          id?: string
          ni_category?: string
          org_id: string
          salary_sacrifice_annual_pence?: number
          standard_hours_per_day?: number | null
          student_loan_plan?: string
          tax_region?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          date_of_birth?: string | null
          id?: string
          ni_category?: string
          org_id?: string
          salary_sacrifice_annual_pence?: number
          standard_hours_per_day?: number | null
          student_loan_plan?: string
          tax_region?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payroll_tax_profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_tax_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      pension_enrolments: {
        Row: {
          assessment_date: string | null
          created_at: string
          employee_contribution_rate: number
          employer_contribution_rate: number
          enrolment_date: string | null
          id: string
          opt_out_date: string | null
          org_id: string
          postponement_end_date: string | null
          scheme_name: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          assessment_date?: string | null
          created_at?: string
          employee_contribution_rate?: number
          employer_contribution_rate?: number
          enrolment_date?: string | null
          id?: string
          opt_out_date?: string | null
          org_id: string
          postponement_end_date?: string | null
          scheme_name?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          assessment_date?: string | null
          created_at?: string
          employee_contribution_rate?: number
          employer_contribution_rate?: number
          enrolment_date?: string | null
          id?: string
          opt_out_date?: string | null
          org_id?: string
          postponement_end_date?: string | null
          scheme_name?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pension_enrolments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pension_enrolments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      permit_conditions: {
        Row: {
          confirmed: boolean
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          id: string
          label: string
          notes: string | null
          org_id: string
          permit_id: string
          required: boolean
          sort_order: number
        }
        Insert: {
          confirmed?: boolean
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          id?: string
          label: string
          notes?: string | null
          org_id: string
          permit_id: string
          required?: boolean
          sort_order?: number
        }
        Update: {
          confirmed?: boolean
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          id?: string
          label?: string
          notes?: string | null
          org_id?: string
          permit_id?: string
          required?: boolean
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "permit_conditions_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permit_conditions_parent_org_fk"
            columns: ["permit_id", "org_id"]
            isOneToOne: false
            referencedRelation: "permits_to_work"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      permits_to_work: {
        Row: {
          activated_at: string | null
          cancelled_at: string | null
          closed_at: string | null
          closeout_notes: string | null
          created_at: string
          created_by: string | null
          emergency_arrangements: string | null
          id: string
          isolation_details: string | null
          issued_at: string | null
          issued_by: string | null
          job_id: string | null
          location: string | null
          org_id: string
          permit_type: string
          reference: string | null
          responsible_person: string | null
          risk_assessment_id: string | null
          scope: string
          status: string
          suspended_at: string | null
          title: string
          updated_at: string
          valid_from: string | null
          valid_until: string | null
        }
        Insert: {
          activated_at?: string | null
          cancelled_at?: string | null
          closed_at?: string | null
          closeout_notes?: string | null
          created_at?: string
          created_by?: string | null
          emergency_arrangements?: string | null
          id?: string
          isolation_details?: string | null
          issued_at?: string | null
          issued_by?: string | null
          job_id?: string | null
          location?: string | null
          org_id: string
          permit_type: string
          reference?: string | null
          responsible_person?: string | null
          risk_assessment_id?: string | null
          scope: string
          status?: string
          suspended_at?: string | null
          title: string
          updated_at?: string
          valid_from?: string | null
          valid_until?: string | null
        }
        Update: {
          activated_at?: string | null
          cancelled_at?: string | null
          closed_at?: string | null
          closeout_notes?: string | null
          created_at?: string
          created_by?: string | null
          emergency_arrangements?: string | null
          id?: string
          isolation_details?: string | null
          issued_at?: string | null
          issued_by?: string | null
          job_id?: string | null
          location?: string | null
          org_id?: string
          permit_type?: string
          reference?: string | null
          responsible_person?: string | null
          risk_assessment_id?: string | null
          scope?: string
          status?: string
          suspended_at?: string | null
          title?: string
          updated_at?: string
          valid_from?: string | null
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "permits_to_work_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permits_to_work_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permits_to_work_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permits_to_work_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permits_to_work_risk_assessment_id_fkey"
            columns: ["risk_assessment_id"]
            isOneToOne: false
            referencedRelation: "risk_assessments"
            referencedColumns: ["id"]
          },
        ]
      }
      phone_numbers: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          e164: string
          id: string
          label: string | null
          org_id: string
          provider: string
          provider_auth_secret: string | null
          provider_number_sid: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          e164: string
          id?: string
          label?: string | null
          org_id: string
          provider: string
          provider_auth_secret?: string | null
          provider_number_sid?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          e164?: string
          id?: string
          label?: string | null
          org_id?: string
          provider?: string
          provider_auth_secret?: string | null
          provider_number_sid?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_numbers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phone_numbers_org_id_fkey"
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
      price_book_items: {
        Row: {
          active: boolean
          category: string | null
          code: string | null
          created_at: string
          created_by: string | null
          description: string
          id: string
          org_id: string
          unit: string
          unit_price: number
          updated_at: string
          vat_rate: number
        }
        Insert: {
          active?: boolean
          category?: string | null
          code?: string | null
          created_at?: string
          created_by?: string | null
          description: string
          id?: string
          org_id: string
          unit?: string
          unit_price?: number
          updated_at?: string
          vat_rate?: number
        }
        Update: {
          active?: boolean
          category?: string | null
          code?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          org_id?: string
          unit?: string
          unit_price?: number
          updated_at?: string
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "price_book_items_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_book_items_org_id_fkey"
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
      push_deliveries: {
        Row: {
          category: string
          created_at: string
          failed_at: string | null
          id: string
          last_error: string | null
          notification_id: string
          org_id: string
          retry_count: number
          scheduled_for: string
          sent_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          failed_at?: string | null
          id?: string
          last_error?: string | null
          notification_id: string
          org_id: string
          retry_count?: number
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          failed_at?: string | null
          id?: string
          last_error?: string | null
          notification_id?: string
          org_id?: string
          retry_count?: number
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_deliveries_notif_org_fkey"
            columns: ["notification_id", "org_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "push_deliveries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_used_at: string | null
          org_id: string
          p256dh: string
          updated_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_used_at?: string | null
          org_id: string
          p256dh: string
          updated_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_used_at?: string | null
          org_id?: string
          p256dh?: string
          updated_at?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
      quote_template_lines: {
        Row: {
          created_at: string
          description: string
          id: string
          org_id: string
          qty: number
          sort_order: number
          template_id: string
          unit: string
          unit_price: number
          vat_rate: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          org_id: string
          qty?: number
          sort_order?: number
          template_id: string
          unit?: string
          unit_price?: number
          vat_rate?: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          org_id?: string
          qty?: number
          sort_order?: number
          template_id?: string
          unit?: string
          unit_price?: number
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_template_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_template_lines_template_fk"
            columns: ["template_id", "org_id"]
            isOneToOne: false
            referencedRelation: "quote_templates"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      quote_templates: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          job_type: string | null
          name: string
          notes: string | null
          org_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          job_type?: string | null
          name: string
          notes?: string | null
          org_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          job_type?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_versions: {
        Row: {
          captured_at: string
          captured_reason: string
          currency: string
          id: string
          line_items: Json
          org_id: string
          quote_id: string
          status: string
          subtotal: number
          total: number
          vat_total: number
          version_number: number
        }
        Insert: {
          captured_at?: string
          captured_reason: string
          currency: string
          id?: string
          line_items?: Json
          org_id: string
          quote_id: string
          status: string
          subtotal: number
          total: number
          vat_total: number
          version_number: number
        }
        Update: {
          captured_at?: string
          captured_reason?: string
          currency?: string
          id?: string
          line_items?: Json
          org_id?: string
          quote_id?: string
          status?: string
          subtotal?: number
          total?: number
          vat_total?: number
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_versions_quote_org_fkey"
            columns: ["quote_id", "org_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id", "org_id"]
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
          cost_labour: number | null
          cost_materials: number | null
          cost_misc: number | null
          cost_subcontractors: number | null
          cost_total: number | null
          created_at: string
          created_by: string | null
          currency: string
          customer_comment: string | null
          customer_id: string
          declined_at: string | null
          eot_agreed_at: string | null
          eot_agreed_by: string | null
          eot_agreed_completion_date: string | null
          eot_requested_completion_date: string | null
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
          cost_labour?: number | null
          cost_materials?: number | null
          cost_misc?: number | null
          cost_subcontractors?: number | null
          cost_total?: number | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_comment?: string | null
          customer_id: string
          declined_at?: string | null
          eot_agreed_at?: string | null
          eot_agreed_by?: string | null
          eot_agreed_completion_date?: string | null
          eot_requested_completion_date?: string | null
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
          cost_labour?: number | null
          cost_materials?: number | null
          cost_misc?: number | null
          cost_subcontractors?: number | null
          cost_total?: number | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_comment?: string | null
          customer_id?: string
          declined_at?: string | null
          eot_agreed_at?: string | null
          eot_agreed_by?: string | null
          eot_agreed_completion_date?: string | null
          eot_requested_completion_date?: string | null
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
            foreignKeyName: "quotes_customer_org_fkey"
            columns: ["customer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "quotes_eot_agreed_by_fkey"
            columns: ["eot_agreed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "quotes_lead_org_fkey"
            columns: ["lead_id", "org_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "quotes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_property_org_fkey"
            columns: ["property_id", "org_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id", "org_id"]
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
      report_subscriptions: {
        Row: {
          active: boolean
          cadence: string
          created_at: string
          created_by: string | null
          format: string
          id: string
          last_run_on: string | null
          org_id: string
          recipients: string[]
          report_key: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          cadence: string
          created_at?: string
          created_by?: string | null
          format?: string
          id?: string
          last_run_on?: string | null
          org_id: string
          recipients: string[]
          report_key: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          cadence?: string
          created_at?: string
          created_by?: string | null
          format?: string
          id?: string
          last_run_on?: string | null
          org_id?: string
          recipients?: string[]
          report_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_subscriptions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      retention_policies: {
        Row: {
          created_at: string
          created_by: string | null
          enabled: boolean
          id: string
          org_id: string
          retention_days: number
          table_name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          org_id: string
          retention_days: number
          table_name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          org_id?: string
          retention_days?: number
          table_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "retention_policies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retention_policies_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      retention_purge_log: {
        Row: {
          created_at: string
          cutoff: string
          error: string | null
          finished_at: string | null
          id: string
          mode: string
          org_id: string
          policy_id: string | null
          requested_by: string | null
          retention_days: number
          rows_deleted: number
          rows_matched: number
          started_at: string
          status: string
          table_name: string
        }
        Insert: {
          created_at?: string
          cutoff: string
          error?: string | null
          finished_at?: string | null
          id?: string
          mode: string
          org_id: string
          policy_id?: string | null
          requested_by?: string | null
          retention_days: number
          rows_deleted?: number
          rows_matched?: number
          started_at?: string
          status: string
          table_name: string
        }
        Update: {
          created_at?: string
          cutoff?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          mode?: string
          org_id?: string
          policy_id?: string | null
          requested_by?: string | null
          retention_days?: number
          rows_deleted?: number
          rows_matched?: number
          started_at?: string
          status?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "retention_purge_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retention_purge_log_policy_fk"
            columns: ["policy_id", "org_id"]
            isOneToOne: false
            referencedRelation: "retention_policies"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "retention_purge_log_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
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
      risk_assessment_hazards: {
        Row: {
          control_measures: string
          created_at: string
          hazard: string
          id: string
          likelihood: number
          org_id: string
          residual_likelihood: number | null
          residual_rating: number | null
          residual_severity: number | null
          risk_assessment_id: string
          risk_rating: number | null
          severity: number
          sort_order: number
          who_at_risk: string | null
        }
        Insert: {
          control_measures: string
          created_at?: string
          hazard: string
          id?: string
          likelihood: number
          org_id: string
          residual_likelihood?: number | null
          residual_rating?: number | null
          residual_severity?: number | null
          risk_assessment_id: string
          risk_rating?: number | null
          severity: number
          sort_order?: number
          who_at_risk?: string | null
        }
        Update: {
          control_measures?: string
          created_at?: string
          hazard?: string
          id?: string
          likelihood?: number
          org_id?: string
          residual_likelihood?: number | null
          residual_rating?: number | null
          residual_severity?: number | null
          risk_assessment_id?: string
          risk_rating?: number | null
          severity?: number
          sort_order?: number
          who_at_risk?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rah_parent_org_fk"
            columns: ["risk_assessment_id", "org_id"]
            isOneToOne: false
            referencedRelation: "risk_assessments"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      risk_assessments: {
        Row: {
          activity: string
          assessment_date: string | null
          assessor_id: string | null
          created_at: string
          created_by: string | null
          id: string
          issued_at: string | null
          issued_by: string | null
          job_id: string | null
          location: string | null
          method_statement: string | null
          org_id: string
          ppe: string[]
          reference: string | null
          review_date: string | null
          revision_number: number
          root_risk_assessment_id: string
          status: string
          supersedes_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          activity: string
          assessment_date?: string | null
          assessor_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          issued_at?: string | null
          issued_by?: string | null
          job_id?: string | null
          location?: string | null
          method_statement?: string | null
          org_id: string
          ppe?: string[]
          reference?: string | null
          review_date?: string | null
          revision_number?: number
          root_risk_assessment_id: string
          status?: string
          supersedes_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          activity?: string
          assessment_date?: string | null
          assessor_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          issued_at?: string | null
          issued_by?: string | null
          job_id?: string | null
          location?: string | null
          method_statement?: string | null
          org_id?: string
          ppe?: string[]
          reference?: string | null
          review_date?: string | null
          revision_number?: number
          root_risk_assessment_id?: string
          status?: string
          supersedes_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "risk_assessments_assessor_id_fkey"
            columns: ["assessor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_assessments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_assessments_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_assessments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_assessments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_assessments_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "risk_assessments"
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
      safety_acknowledgements: {
        Row: {
          acknowledged_at: string
          created_at: string
          id: string
          ip_hash: string | null
          org_id: string
          signature_image_bucket: string | null
          signature_image_path: string | null
          signed_name: string
          statement: string
          statement_version: string
          subject_id: string
          subject_type: string
          subject_version: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          acknowledged_at?: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          org_id: string
          signature_image_bucket?: string | null
          signature_image_path?: string | null
          signed_name: string
          statement: string
          statement_version?: string
          subject_id: string
          subject_type: string
          subject_version: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          acknowledged_at?: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          org_id?: string
          signature_image_bucket?: string | null
          signature_image_path?: string | null
          signed_name?: string
          statement?: string
          statement_version?: string
          subject_id?: string
          subject_type?: string
          subject_version?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "safety_acknowledgements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "safety_acknowledgements_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      service_booking_slots: {
        Row: {
          active: boolean
          capacity: number
          created_at: string
          created_by: string | null
          ends_at: string
          id: string
          label: string | null
          org_id: string
          starts_at: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          capacity?: number
          created_at?: string
          created_by?: string | null
          ends_at: string
          id?: string
          label?: string | null
          org_id: string
          starts_at: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          capacity?: number
          created_at?: string
          created_by?: string | null
          ends_at?: string
          id?: string
          label?: string | null
          org_id?: string
          starts_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_booking_slots_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_booking_slots_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      service_bookings: {
        Row: {
          cancelled_at: string | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          customer_id: string
          id: string
          notes: string | null
          org_id: string
          slot_id: string
          status: string
          updated_at: string
          warranty_id: string | null
        }
        Insert: {
          cancelled_at?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          customer_id: string
          id?: string
          notes?: string | null
          org_id: string
          slot_id: string
          status?: string
          updated_at?: string
          warranty_id?: string | null
        }
        Update: {
          cancelled_at?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          customer_id?: string
          id?: string
          notes?: string | null
          org_id?: string
          slot_id?: string
          status?: string
          updated_at?: string
          warranty_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_bookings_customer_org_fkey"
            columns: ["customer_id", "org_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "service_bookings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_bookings_slot_org_fkey"
            columns: ["slot_id", "org_id"]
            isOneToOne: false
            referencedRelation: "service_booking_slots"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "service_bookings_warranty_org_fkey"
            columns: ["warranty_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_warranties"
            referencedColumns: ["id", "org_id"]
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
          signature_image_bucket: string | null
          signature_image_path: string | null
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
          signature_image_bucket?: string | null
          signature_image_path?: string | null
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
          signature_image_bucket?: string | null
          signature_image_path?: string | null
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
          client_write_key: string | null
          created_at: string
          created_by: string | null
          delays: string | null
          entry_date: string
          id: string
          job_id: string | null
          labour_count: number | null
          last_offline_write_key: string | null
          notes: string | null
          offline_authored_at: string | null
          org_id: string
          source: string
          updated_at: string
          weather: string | null
          work_summary: string | null
        }
        Insert: {
          client_write_key?: string | null
          created_at?: string
          created_by?: string | null
          delays?: string | null
          entry_date?: string
          id?: string
          job_id?: string | null
          labour_count?: number | null
          last_offline_write_key?: string | null
          notes?: string | null
          offline_authored_at?: string | null
          org_id: string
          source?: string
          updated_at?: string
          weather?: string | null
          work_summary?: string | null
        }
        Update: {
          client_write_key?: string | null
          created_at?: string
          created_by?: string | null
          delays?: string | null
          entry_date?: string
          id?: string
          job_id?: string | null
          labour_count?: number | null
          last_offline_write_key?: string | null
          notes?: string | null
          offline_authored_at?: string | null
          org_id?: string
          source?: string
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
      site_inductions: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          inducted_at: string
          induction_version: string
          ip_hash: string | null
          org_id: string
          person_company: string | null
          person_name: string | null
          signature_image_bucket: string | null
          signature_image_path: string | null
          signed_name: string
          site_id: string
          statement: string
          statement_version: string
          user_agent: string | null
          user_id: string | null
          valid_until: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          inducted_at?: string
          induction_version: string
          ip_hash?: string | null
          org_id: string
          person_company?: string | null
          person_name?: string | null
          signature_image_bucket?: string | null
          signature_image_path?: string | null
          signed_name: string
          site_id: string
          statement: string
          statement_version?: string
          user_agent?: string | null
          user_id?: string | null
          valid_until?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          inducted_at?: string
          induction_version?: string
          ip_hash?: string | null
          org_id?: string
          person_company?: string | null
          person_name?: string | null
          signature_image_bucket?: string | null
          signature_image_path?: string | null
          signed_name?: string
          site_id?: string
          statement?: string
          statement_version?: string
          user_agent?: string | null
          user_id?: string | null
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "site_inductions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_inductions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_inductions_site_org_fkey"
            columns: ["site_id", "org_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "site_inductions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      site_reports: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          client_write_key: string | null
          content: Json
          created_at: string
          customer_id: string | null
          customer_notified_at: string | null
          id: string
          issued_at: string | null
          job_id: string | null
          offline_authored_at: string | null
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
          client_write_key?: string | null
          content?: Json
          created_at?: string
          customer_id?: string | null
          customer_notified_at?: string | null
          id?: string
          issued_at?: string | null
          job_id?: string | null
          offline_authored_at?: string | null
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
          client_write_key?: string | null
          content?: Json
          created_at?: string
          customer_id?: string | null
          customer_notified_at?: string | null
          id?: string
          issued_at?: string | null
          job_id?: string | null
          offline_authored_at?: string | null
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
      site_visitors: {
        Row: {
          company: string | null
          created_at: string
          host_user_id: string | null
          id: string
          org_id: string
          purpose: string | null
          signed_in_at: string
          signed_in_by: string | null
          signed_out_at: string | null
          signed_out_by: string | null
          site_id: string
          updated_at: string
          vehicle_registration: string | null
          visitor_name: string
        }
        Insert: {
          company?: string | null
          created_at?: string
          host_user_id?: string | null
          id?: string
          org_id: string
          purpose?: string | null
          signed_in_at?: string
          signed_in_by?: string | null
          signed_out_at?: string | null
          signed_out_by?: string | null
          site_id: string
          updated_at?: string
          vehicle_registration?: string | null
          visitor_name: string
        }
        Update: {
          company?: string | null
          created_at?: string
          host_user_id?: string | null
          id?: string
          org_id?: string
          purpose?: string | null
          signed_in_at?: string
          signed_in_by?: string | null
          signed_out_at?: string | null
          signed_out_by?: string | null
          site_id?: string
          updated_at?: string
          vehicle_registration?: string | null
          visitor_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "site_visitors_host_user_id_fkey"
            columns: ["host_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_visitors_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_visitors_signed_in_by_fkey"
            columns: ["signed_in_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_visitors_signed_out_by_fkey"
            columns: ["signed_out_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_visitors_site_org_fkey"
            columns: ["site_id", "org_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      sites: {
        Row: {
          active: boolean
          address_line1: string | null
          address_line2: string | null
          city: string | null
          country: string
          county: string | null
          created_at: string
          created_by: string | null
          id: string
          kind: string
          name: string
          notes: string | null
          org_id: string
          postcode: string | null
          updated_at: string
          vehicle_asset_id: string | null
        }
        Insert: {
          active?: boolean
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string
          county?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          name: string
          notes?: string | null
          org_id: string
          postcode?: string | null
          updated_at?: string
          vehicle_asset_id?: string | null
        }
        Update: {
          active?: boolean
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string
          county?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          name?: string
          notes?: string | null
          org_id?: string
          postcode?: string | null
          updated_at?: string
          vehicle_asset_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sites_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sites_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sites_vehicle_asset_id_fkey"
            columns: ["vehicle_asset_id"]
            isOneToOne: false
            referencedRelation: "fleet_vehicles"
            referencedColumns: ["asset_id"]
          },
        ]
      }
      sms_deliveries: {
        Row: {
          category: string
          created_at: string
          failed_at: string | null
          id: string
          last_error: string | null
          notification_id: string
          org_id: string
          provider_message_id: string | null
          retry_count: number
          scheduled_for: string
          sent_at: string | null
          status: string
          to_phone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          failed_at?: string | null
          id?: string
          last_error?: string | null
          notification_id: string
          org_id: string
          provider_message_id?: string | null
          retry_count?: number
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          to_phone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          failed_at?: string | null
          id?: string
          last_error?: string | null
          notification_id?: string
          org_id?: string
          provider_message_id?: string | null
          retry_count?: number
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          to_phone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_deliveries_notif_org_fkey"
            columns: ["notification_id", "org_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "sms_deliveries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      snags: {
        Row: {
          assigned_to: string | null
          client_write_key: string | null
          created_at: string
          description: string | null
          due_date: string | null
          id: string
          job_id: string | null
          last_offline_write_key: string | null
          location: string | null
          offline_authored_at: string | null
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
          client_write_key?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          job_id?: string | null
          last_offline_write_key?: string | null
          location?: string | null
          offline_authored_at?: string | null
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
          client_write_key?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          job_id?: string | null
          last_offline_write_key?: string | null
          location?: string | null
          offline_authored_at?: string | null
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
      sso_consumed_assertions: {
        Row: {
          assertion_id: string
          consumed_at: string
          id: string
          not_on_or_after: string
          org_id: string
        }
        Insert: {
          assertion_id: string
          consumed_at?: string
          id?: string
          not_on_or_after: string
          org_id: string
        }
        Update: {
          assertion_id?: string
          consumed_at?: string
          id?: string
          not_on_or_after?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sso_consumed_assertions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sso_provisioning_audit: {
        Row: {
          created_at: string
          detail: Json
          event: string
          id: string
          org_id: string
          outcome: string
          protocol: string
          subject: string | null
        }
        Insert: {
          created_at?: string
          detail?: Json
          event: string
          id?: string
          org_id: string
          outcome: string
          protocol: string
          subject?: string | null
        }
        Update: {
          created_at?: string
          detail?: Json
          event?: string
          id?: string
          org_id?: string
          outcome?: string
          protocol?: string
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sso_provisioning_audit_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_compensation: {
        Row: {
          emergency_contact: Json | null
          hourly_pay: number | null
          updated_at: string
          updated_by: string | null
          user_id: string
        }
        Insert: {
          emergency_contact?: Json | null
          hourly_pay?: number | null
          updated_at?: string
          updated_by?: string | null
          user_id: string
        }
        Update: {
          emergency_contact?: Json | null
          hourly_pay?: number | null
          updated_at?: string
          updated_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_compensation_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_compensation_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_qualifications: {
        Row: {
          created_at: string
          created_by: string | null
          document_bucket: string | null
          document_path: string | null
          expires_on: string | null
          id: string
          issued_on: string | null
          notes: string | null
          org_id: string
          qualification_type: string
          reference_no: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          document_bucket?: string | null
          document_path?: string | null
          expires_on?: string | null
          id?: string
          issued_on?: string | null
          notes?: string | null
          org_id: string
          qualification_type: string
          reference_no?: string | null
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          document_bucket?: string | null
          document_path?: string | null
          expires_on?: string | null
          id?: string
          issued_on?: string | null
          notes?: string | null
          org_id?: string
          qualification_type?: string
          reference_no?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_qualifications_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_qualifications_member_org_fkey"
            columns: ["org_id", "user_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["org_id", "user_id"]
          },
          {
            foreignKeyName: "staff_qualifications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
      stock_items: {
        Row: {
          active: boolean
          barcode: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          notes: string | null
          org_id: string
          preferred_supplier_id: string | null
          reorder_level: number | null
          reorder_quantity: number | null
          sku: string | null
          supplier_reference: string | null
          target_level: number | null
          unit: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          barcode?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          notes?: string | null
          org_id: string
          preferred_supplier_id?: string | null
          reorder_level?: number | null
          reorder_quantity?: number | null
          sku?: string | null
          supplier_reference?: string | null
          target_level?: number | null
          unit?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          barcode?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          notes?: string | null
          org_id?: string
          preferred_supplier_id?: string | null
          reorder_level?: number | null
          reorder_quantity?: number | null
          sku?: string | null
          supplier_reference?: string | null
          target_level?: number | null
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_items_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_items_preferred_supplier_id_fkey"
            columns: ["preferred_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_movements: {
        Row: {
          actor_id: string | null
          corrects_movement_id: string | null
          cost_effect: number | null
          costed_qty_effect: number | null
          created_at: string
          effect: number
          grn_line_id: string | null
          id: string
          job_id: string | null
          material_request_line_id: string | null
          movement_type: string
          notes: string | null
          occurred_at: string
          org_id: string
          qty: number
          site_id: string
          stock_item_id: string
          transfer_group_id: string | null
          unit_cost: number | null
        }
        Insert: {
          actor_id?: string | null
          corrects_movement_id?: string | null
          cost_effect?: number | null
          costed_qty_effect?: number | null
          created_at?: string
          effect: number
          grn_line_id?: string | null
          id?: string
          job_id?: string | null
          material_request_line_id?: string | null
          movement_type: string
          notes?: string | null
          occurred_at?: string
          org_id: string
          qty: number
          site_id: string
          stock_item_id: string
          transfer_group_id?: string | null
          unit_cost?: number | null
        }
        Update: {
          actor_id?: string | null
          corrects_movement_id?: string | null
          cost_effect?: number | null
          costed_qty_effect?: number | null
          created_at?: string
          effect?: number
          grn_line_id?: string | null
          id?: string
          job_id?: string | null
          material_request_line_id?: string | null
          movement_type?: string
          notes?: string | null
          occurred_at?: string
          org_id?: string
          qty?: number
          site_id?: string
          stock_item_id?: string
          transfer_group_id?: string | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_corrects_org_fkey"
            columns: ["corrects_movement_id", "org_id"]
            isOneToOne: false
            referencedRelation: "stock_movements"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "stock_movements_grn_line_org_fkey"
            columns: ["grn_line_id", "org_id"]
            isOneToOne: false
            referencedRelation: "goods_received_lines"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "stock_movements_item_org_fkey"
            columns: ["stock_item_id", "org_id"]
            isOneToOne: false
            referencedRelation: "stock_items"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "stock_movements_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_mrl_org_fkey"
            columns: ["material_request_line_id", "org_id"]
            isOneToOne: false
            referencedRelation: "material_request_lines"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "stock_movements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_site_org_fkey"
            columns: ["site_id", "org_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      stocktake_lines: {
        Row: {
          counted_at: string | null
          counted_by: string | null
          counted_qty: number | null
          created_at: string
          expected_qty: number
          id: string
          org_id: string
          posted_movement_id: string | null
          posted_variance: number | null
          session_id: string
          stock_item_id: string
        }
        Insert: {
          counted_at?: string | null
          counted_by?: string | null
          counted_qty?: number | null
          created_at?: string
          expected_qty: number
          id?: string
          org_id: string
          posted_movement_id?: string | null
          posted_variance?: number | null
          session_id: string
          stock_item_id: string
        }
        Update: {
          counted_at?: string | null
          counted_by?: string | null
          counted_qty?: number | null
          created_at?: string
          expected_qty?: number
          id?: string
          org_id?: string
          posted_movement_id?: string | null
          posted_variance?: number | null
          session_id?: string
          stock_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stocktake_lines_counted_by_fkey"
            columns: ["counted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_lines_item_org_fkey"
            columns: ["stock_item_id", "org_id"]
            isOneToOne: false
            referencedRelation: "stock_items"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "stocktake_lines_movement_org_fkey"
            columns: ["posted_movement_id", "org_id"]
            isOneToOne: false
            referencedRelation: "stock_movements"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "stocktake_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_lines_session_org_fkey"
            columns: ["session_id", "org_id"]
            isOneToOne: false
            referencedRelation: "stocktake_sessions"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      stocktake_sessions: {
        Row: {
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          id: string
          notes: string | null
          opened_at: string
          opened_by: string | null
          org_id: string
          posted_at: string | null
          posted_by: string | null
          reference: string | null
          site_id: string
          status: string
          updated_at: string
        }
        Insert: {
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          opened_at?: string
          opened_by?: string | null
          org_id: string
          posted_at?: string | null
          posted_by?: string | null
          reference?: string | null
          site_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          opened_at?: string
          opened_by?: string | null
          org_id?: string
          posted_at?: string | null
          posted_by?: string | null
          reference?: string | null
          site_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stocktake_sessions_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_sessions_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_sessions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_sessions_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_sessions_site_org_fkey"
            columns: ["site_id", "org_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      supplier_payment_allocations: {
        Row: {
          amount: number
          cis_basis: number | null
          cis_bill_citb: number | null
          cis_bill_gross: number | null
          cis_bill_materials: number | null
          cis_bill_net: number | null
          cis_deduction: number | null
          cis_rate_applied: number | null
          cis_reverse_charge_vat: number | null
          cis_vat_treatment: string | null
          created_at: string
          created_by: string | null
          finance_id: string
          id: string
          org_id: string
          payment_id: string
          supplier_id: string
        }
        Insert: {
          amount: number
          cis_basis?: number | null
          cis_bill_citb?: number | null
          cis_bill_gross?: number | null
          cis_bill_materials?: number | null
          cis_bill_net?: number | null
          cis_deduction?: number | null
          cis_rate_applied?: number | null
          cis_reverse_charge_vat?: number | null
          cis_vat_treatment?: string | null
          created_at?: string
          created_by?: string | null
          finance_id: string
          id?: string
          org_id: string
          payment_id: string
          supplier_id: string
        }
        Update: {
          amount?: number
          cis_basis?: number | null
          cis_bill_citb?: number | null
          cis_bill_gross?: number | null
          cis_bill_materials?: number | null
          cis_bill_net?: number | null
          cis_deduction?: number | null
          cis_rate_applied?: number | null
          cis_reverse_charge_vat?: number | null
          cis_vat_treatment?: string | null
          created_at?: string
          created_by?: string | null
          finance_id?: string
          id?: string
          org_id?: string
          payment_id?: string
          supplier_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_payment_allocations_bill_fk"
            columns: ["finance_id", "org_id", "supplier_id"]
            isOneToOne: false
            referencedRelation: "finances"
            referencedColumns: ["id", "org_id", "supplier_id"]
          },
          {
            foreignKeyName: "supplier_payment_allocations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payment_allocations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payment_allocations_payment_fk"
            columns: ["payment_id", "org_id", "supplier_id"]
            isOneToOne: false
            referencedRelation: "supplier_payments"
            referencedColumns: ["id", "org_id", "supplier_id"]
          },
        ]
      }
      supplier_payments: {
        Row: {
          cis_withheld: number
          created_at: string
          created_by: string | null
          gross_amount: number
          id: string
          method: string
          net_paid: number
          notes: string | null
          org_id: string
          paid_at: string
          reference: string | null
          supplier_id: string
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          cis_withheld?: number
          created_at?: string
          created_by?: string | null
          gross_amount: number
          id?: string
          method?: string
          net_paid: number
          notes?: string | null
          org_id: string
          paid_at: string
          reference?: string | null
          supplier_id: string
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          cis_withheld?: number
          created_at?: string
          created_by?: string | null
          gross_amount?: number
          id?: string
          method?: string
          net_paid?: number
          notes?: string | null
          org_id?: string
          paid_at?: string
          reference?: string | null
          supplier_id?: string
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "supplier_payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_payments_supplier_fk"
            columns: ["supplier_id", "org_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "supplier_payments_voided_by_fkey"
            columns: ["voided_by"]
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
          payment_terms_days: number | null
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
          payment_terms_days?: number | null
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
          payment_terms_days?: number | null
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
          warranty_id: string | null
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
          warranty_id?: string | null
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
          warranty_id?: string | null
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
          {
            foreignKeyName: "support_tickets_warranty_org_fkey"
            columns: ["warranty_id", "org_id"]
            isOneToOne: false
            referencedRelation: "job_warranties"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      telematics_connections: {
        Row: {
          access_token: string | null
          connected_at: string | null
          connected_by: string | null
          created_at: string
          external_account_id: string | null
          id: string
          last_error: string | null
          last_sync_at: string | null
          org_id: string
          provider: string
          refresh_token: string | null
          status: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          external_account_id?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          org_id: string
          provider: string
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          external_account_id?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          org_id?: string
          provider?: string
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telematics_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telematics_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      telematics_readings: {
        Row: {
          connection_id: string
          created_at: string
          id: string
          latitude: number | null
          longitude: number | null
          odometer_miles: number | null
          org_id: string
          recorded_at: string
          source_event_id: string | null
          vehicle_id: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          odometer_miles?: number | null
          org_id: string
          recorded_at: string
          source_event_id?: string | null
          vehicle_id: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          odometer_miles?: number | null
          org_id?: string
          recorded_at?: string
          source_event_id?: string | null
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "telematics_readings_connection_org_fk"
            columns: ["connection_id", "org_id"]
            isOneToOne: false
            referencedRelation: "telematics_connections"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "telematics_readings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telematics_readings_vehicle_org_fk"
            columns: ["vehicle_id", "org_id"]
            isOneToOne: false
            referencedRelation: "fleet_vehicles"
            referencedColumns: ["asset_id", "org_id"]
          },
        ]
      }
      tenant_attachments: {
        Row: {
          client_write_key: string | null
          content_hash: string | null
          created_at: string
          filename: string
          id: string
          mime_type: string | null
          offline_authored_at: string | null
          org_id: string
          portal_visible: boolean
          size_bytes: number | null
          storage_path: string
          target_id: string
          target_table: string
          uploaded_by: string | null
        }
        Insert: {
          client_write_key?: string | null
          content_hash?: string | null
          created_at?: string
          filename: string
          id?: string
          mime_type?: string | null
          offline_authored_at?: string | null
          org_id: string
          portal_visible?: boolean
          size_bytes?: number | null
          storage_path: string
          target_id: string
          target_table: string
          uploaded_by?: string | null
        }
        Update: {
          client_write_key?: string | null
          content_hash?: string | null
          created_at?: string
          filename?: string
          id?: string
          mime_type?: string | null
          offline_authored_at?: string | null
          org_id?: string
          portal_visible?: boolean
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
          issued_at: string | null
          issued_by: string | null
          job_id: string | null
          key_points: string | null
          location: string | null
          notes: string | null
          org_id: string
          permit_to_work_id: string | null
          ppe: string[]
          presenter: string | null
          reference: string | null
          revision_number: number
          risk_assessment_id: string | null
          root_toolbox_talk_id: string
          snapshot: Json | null
          status: string
          supersedes_id: string | null
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
          issued_at?: string | null
          issued_by?: string | null
          job_id?: string | null
          key_points?: string | null
          location?: string | null
          notes?: string | null
          org_id: string
          permit_to_work_id?: string | null
          ppe?: string[]
          presenter?: string | null
          reference?: string | null
          revision_number?: number
          risk_assessment_id?: string | null
          root_toolbox_talk_id: string
          snapshot?: Json | null
          status?: string
          supersedes_id?: string | null
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
          issued_at?: string | null
          issued_by?: string | null
          job_id?: string | null
          key_points?: string | null
          location?: string | null
          notes?: string | null
          org_id?: string
          permit_to_work_id?: string | null
          ppe?: string[]
          presenter?: string | null
          reference?: string | null
          revision_number?: number
          risk_assessment_id?: string | null
          root_toolbox_talk_id?: string
          snapshot?: Json | null
          status?: string
          supersedes_id?: string | null
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
            foreignKeyName: "toolbox_talks_issued_by_fkey"
            columns: ["issued_by"]
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
          {
            foreignKeyName: "toolbox_talks_permit_to_work_id_fkey"
            columns: ["permit_to_work_id"]
            isOneToOne: false
            referencedRelation: "permits_to_work"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "toolbox_talks_risk_assessment_id_fkey"
            columns: ["risk_assessment_id"]
            isOneToOne: false
            referencedRelation: "risk_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "toolbox_talks_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "toolbox_talks"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          employment_type: string | null
          full_name: string | null
          id: string
          phone: string | null
          start_date: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          employment_type?: string | null
          full_name?: string | null
          id: string
          phone?: string | null
          start_date?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          employment_type?: string | null
          full_name?: string | null
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
      weather_readings: {
        Row: {
          air_temp_c: number | null
          created_at: string
          expires_at: string | null
          feels_like_c: number | null
          fetched_at: string
          humidity_pct: number | null
          id: string
          kind: string
          postcode_district: string
          precip_prob_pct: number | null
          precip_rate_mm_h: number | null
          precip_total_mm: number | null
          provider: string
          resolved_lat: number | null
          resolved_lon: number | null
          valid_at: string
          visibility_m: number | null
          wind_bearing_deg: number | null
          wind_gust_ms: number | null
          wind_speed_ms: number | null
        }
        Insert: {
          air_temp_c?: number | null
          created_at?: string
          expires_at?: string | null
          feels_like_c?: number | null
          fetched_at?: string
          humidity_pct?: number | null
          id?: string
          kind: string
          postcode_district: string
          precip_prob_pct?: number | null
          precip_rate_mm_h?: number | null
          precip_total_mm?: number | null
          provider: string
          resolved_lat?: number | null
          resolved_lon?: number | null
          valid_at: string
          visibility_m?: number | null
          wind_bearing_deg?: number | null
          wind_gust_ms?: number | null
          wind_speed_ms?: number | null
        }
        Update: {
          air_temp_c?: number | null
          created_at?: string
          expires_at?: string | null
          feels_like_c?: number | null
          fetched_at?: string
          humidity_pct?: number | null
          id?: string
          kind?: string
          postcode_district?: string
          precip_prob_pct?: number | null
          precip_rate_mm_h?: number | null
          precip_total_mm?: number | null
          provider?: string
          resolved_lat?: number | null
          resolved_lon?: number | null
          valid_at?: string
          visibility_m?: number | null
          wind_bearing_deg?: number | null
          wind_gust_ms?: number | null
          wind_speed_ms?: number | null
        }
        Relationships: []
      }
      weather_watches: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          id: string
          job_id: string | null
          label: string | null
          org_id: string
          postcode_district: string
          site_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string | null
          label?: string | null
          org_id: string
          postcode_district: string
          site_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string | null
          label?: string | null
          org_id?: string
          postcode_district?: string
          site_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "weather_watches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weather_watches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weather_watches_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weather_watches_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_deliveries: {
        Row: {
          attempt: number
          created_at: string
          delivered_at: string | null
          endpoint_id: string
          event_id: number | null
          id: string
          last_error: string | null
          last_status_code: number | null
          next_attempt_at: string
          org_id: string
          payload: Json
          state: string
          updated_at: string
          verb: string
        }
        Insert: {
          attempt?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id: string
          event_id?: number | null
          id?: string
          last_error?: string | null
          last_status_code?: number | null
          next_attempt_at?: string
          org_id: string
          payload?: Json
          state?: string
          updated_at?: string
          verb: string
        }
        Update: {
          attempt?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id?: string
          event_id?: number | null
          id?: string
          last_error?: string | null
          last_status_code?: number | null
          next_attempt_at?: string
          org_id?: string
          payload?: Json
          state?: string
          updated_at?: string
          verb?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_endpoint_org_fkey"
            columns: ["endpoint_id", "org_id"]
            isOneToOne: false
            referencedRelation: "webhook_endpoints"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      webhook_dispatch_state: {
        Row: {
          id: string
          last_event_id: number
          updated_at: string
        }
        Insert: {
          id?: string
          last_event_id?: number
          updated_at?: string
        }
        Update: {
          id?: string
          last_event_id?: number
          updated_at?: string
        }
        Relationships: []
      }
      webhook_endpoints: {
        Row: {
          consecutive_failures: number
          created_at: string
          created_by: string | null
          description: string | null
          event_verbs: string[]
          id: string
          last_delivery_at: string | null
          org_id: string
          secret: string
          status: string
          updated_at: string
          url: string
          verified_at: string | null
        }
        Insert: {
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          description?: string | null
          event_verbs?: string[]
          id?: string
          last_delivery_at?: string | null
          org_id: string
          secret: string
          status?: string
          updated_at?: string
          url: string
          verified_at?: string | null
        }
        Update: {
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          description?: string | null
          event_verbs?: string[]
          id?: string
          last_delivery_at?: string | null
          org_id?: string
          secret?: string
          status?: string
          updated_at?: string
          url?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_endpoints_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_endpoints_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_assistant_actions: {
        Row: {
          action_type: string
          created_at: string
          detail: Json | null
          enquiry_id: string | null
          error_message: string | null
          id: string
          org_id: string
          review_note: string | null
          review_resolution: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          target_id: string | null
          target_table: string | null
          wamid: string
        }
        Insert: {
          action_type: string
          created_at?: string
          detail?: Json | null
          enquiry_id?: string | null
          error_message?: string | null
          id?: string
          org_id: string
          review_note?: string | null
          review_resolution?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          target_id?: string | null
          target_table?: string | null
          wamid: string
        }
        Update: {
          action_type?: string
          created_at?: string
          detail?: Json | null
          enquiry_id?: string | null
          error_message?: string | null
          id?: string
          org_id?: string
          review_note?: string | null
          review_resolution?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          target_id?: string | null
          target_table?: string | null
          wamid?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_assistant_actions_enquiry_id_fkey"
            columns: ["enquiry_id"]
            isOneToOne: false
            referencedRelation: "inbound_enquiries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_assistant_actions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_assistant_actions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_inbound_media: {
        Row: {
          caption: string | null
          content_hash: string | null
          created_at: string
          declared_sha256: string | null
          error_message: string | null
          filename: string | null
          id: string
          media_id: string
          message_type: string
          mime_type: string | null
          org_id: string
          refused_reason: string | null
          size_bytes: number | null
          status: string
          storage_path: string | null
          stored_at: string | null
          transcript: string | null
          transcript_status: string
          wamid: string
        }
        Insert: {
          caption?: string | null
          content_hash?: string | null
          created_at?: string
          declared_sha256?: string | null
          error_message?: string | null
          filename?: string | null
          id?: string
          media_id: string
          message_type: string
          mime_type?: string | null
          org_id: string
          refused_reason?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
          stored_at?: string | null
          transcript?: string | null
          transcript_status?: string
          wamid: string
        }
        Update: {
          caption?: string | null
          content_hash?: string | null
          created_at?: string
          declared_sha256?: string | null
          error_message?: string | null
          filename?: string | null
          id?: string
          media_id?: string
          message_type?: string
          mime_type?: string | null
          org_id?: string
          refused_reason?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
          stored_at?: string | null
          transcript?: string | null
          transcript_status?: string
          wamid?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_inbound_media_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
      worker_acknowledgements: {
        Row: {
          acknowledged_at: string
          created_at: string
          id: string
          ip_hash: string | null
          job_id: string
          org_id: string
          signature_image_bucket: string | null
          signature_image_path: string | null
          signed_name: string
          statement: string
          statement_version: string
          subject_id: string
          subject_type: string
          subject_version: string
          token_id: string
          user_agent: string | null
        }
        Insert: {
          acknowledged_at?: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          job_id: string
          org_id: string
          signature_image_bucket?: string | null
          signature_image_path?: string | null
          signed_name: string
          statement: string
          statement_version?: string
          subject_id: string
          subject_type: string
          subject_version: string
          token_id: string
          user_agent?: string | null
        }
        Update: {
          acknowledged_at?: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          job_id?: string
          org_id?: string
          signature_image_bucket?: string | null
          signature_image_path?: string | null
          signed_name?: string
          statement?: string
          statement_version?: string
          subject_id?: string
          subject_type?: string
          subject_version?: string
          token_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "worker_ack_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "worker_ack_token_org_fkey"
            columns: ["token_id", "org_id"]
            isOneToOne: false
            referencedRelation: "worker_signoff_tokens"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "worker_acknowledgements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_signoff_tokens: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          job_id: string
          last_used_at: string | null
          org_id: string
          revoked_at: string | null
          revoked_by: string | null
          token_hash: string
          worker_company: string | null
          worker_name: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at: string
          id?: string
          job_id: string
          last_used_at?: string | null
          org_id: string
          revoked_at?: string | null
          revoked_by?: string | null
          token_hash: string
          worker_company?: string | null
          worker_name: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          job_id?: string
          last_used_at?: string | null
          org_id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          token_hash?: string
          worker_company?: string | null
          worker_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_signoff_tokens_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_signoff_tokens_job_org_fkey"
            columns: ["job_id", "org_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "worker_signoff_tokens_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_signoff_tokens_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "users"
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
      stock_balances: {
        Row: {
          last_movement_at: string | null
          movement_count: number | null
          org_id: string | null
          quantity: number | null
          site_id: string | null
          stock_item_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_item_org_fkey"
            columns: ["stock_item_id", "org_id"]
            isOneToOne: false
            referencedRelation: "stock_items"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "stock_movements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_site_org_fkey"
            columns: ["site_id", "org_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      stock_valuation: {
        Row: {
          avg_unit_cost: number | null
          book_value: number | null
          costed_qty: number | null
          last_movement_at: string | null
          on_hand: number | null
          org_id: string | null
          stock_item_id: string | null
          uncosted_qty: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_item_org_fkey"
            columns: ["stock_item_id", "org_id"]
            isOneToOne: false
            referencedRelation: "stock_items"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "stock_movements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      works_quality_plan_status: {
        Row: {
          failed_items: number | null
          hold_point_breaches: number | null
          hold_point_items: number | null
          job_id: string | null
          open_hold_item_number: number | null
          open_hold_points: number | null
          org_id: string | null
          outstanding_required_items: number | null
          plan_id: string | null
          signed_off_items: number | null
          status: string | null
          total_items: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inspection_test_plans_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_test_plans_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _generate_stage_invoice_row: {
        Args: { p_due_date?: string; p_stage_id: string }
        Returns: string
      }
      _introspect_bare_cross_tenant_fks: {
        Args: never
        Returns: {
          child: string
          conname: string
          parent: string
        }[]
      }
      _introspect_client_table_grants: {
        Args: { p_tables: string[] }
        Returns: {
          grantee: string
          privilege_type: string
          table_name: string
        }[]
      }
      _introspect_org_scoped_tables: {
        Args: never
        Returns: {
          table_name: string
        }[]
      }
      _introspect_secdef_org_rpcs: {
        Args: never
        Returns: {
          anon_exec: boolean
          auth_exec: boolean
          guarded: boolean
          identity_args: string
          proname: string
        }[]
      }
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
      advance_material_request_fulfilment: {
        Args: { p_org_id: string; p_request_id: string }
        Returns: string
      }
      ai_clear_employee_limit: {
        Args: {
          p_note?: string
          p_org_id: string
          p_set_by?: string
          p_user_id: string
        }
        Returns: {
          old_pence: number
        }[]
      }
      ai_clear_org_ceiling: {
        Args: { p_note?: string; p_org_id: string; p_set_by?: string }
        Returns: {
          old_pence: number
        }[]
      }
      ai_employee_month_totals: {
        Args: { p_month?: string; p_org_id: string; p_user_id: string }
        Returns: {
          committed_pence: number
          invocations: number
          live_pence: number
          month_start: string
          org_id: string
          user_id: string
        }[]
      }
      ai_invocations_month_by_feature: {
        Args: { p_month?: string; p_org_id?: string }
        Returns: {
          failures: number
          feature: string
          invocations: number
          successes: number
          total_cost_pence: number
        }[]
      }
      ai_invocations_month_totals: {
        Args: { p_month?: string; p_org_id?: string }
        Returns: {
          failures: number
          input_tokens: number
          invocations: number
          month_start: string
          org_id: string
          output_tokens: number
          successes: number
          total_cost_pence: number
        }[]
      }
      ai_release_reservation: {
        Args: { p_reason?: string; p_reservation_id: string }
        Returns: {
          outcome: string
        }[]
      }
      ai_reservations_month_totals: {
        Args: { p_month?: string; p_org_id?: string }
        Returns: {
          expired_count: number
          live_count: number
          live_pence: number
          month_start: string
          org_id: string
          overrun_count: number
          released_count: number
          settled_count: number
        }[]
      }
      ai_reserve_invocation: {
        Args: {
          p_ceiling_pence?: number
          p_content_hash?: string
          p_dedupe_window_seconds?: number
          p_estimate_pence: number
          p_feature: string
          p_org_id: string
          p_task_class: string
          p_ttl_seconds?: number
          p_user_id?: string
        }
        Returns: {
          block_reason: string
          ceiling_pence: number
          committed_pence: number
          duplicate_reason: string
          outcome: string
          reservation_id: string
          reserved_pence: number
        }[]
      }
      ai_set_employee_limit: {
        Args: {
          p_limit_pence: number
          p_note?: string
          p_org_id: string
          p_set_by?: string
          p_user_id: string
        }
        Returns: {
          new_pence: number
          old_pence: number
        }[]
      }
      ai_set_org_ceiling: {
        Args: {
          p_ceiling_pence: number
          p_note?: string
          p_org_id: string
          p_set_by?: string
        }
        Returns: {
          new_pence: number
          old_pence: number
        }[]
      }
      ai_settle_reservation: {
        Args: {
          p_cost_pence: number
          p_error_code?: string
          p_input_tokens?: number
          p_latency_ms?: number
          p_model: string
          p_output_tokens?: number
          p_provider: string
          p_reservation_id: string
          p_success: boolean
        }
        Returns: {
          cost_pence: number
          invocation_id: string
          outcome: string
        }[]
      }
      allocate_payment: {
        Args: {
          p_allocations: Json
          p_amount: number
          p_method: string
          p_notes: string
          p_org_id: string
          p_paid_at: string
          p_reference: string
          p_source: string
        }
        Returns: string
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
      automation_invoice_job_completion: {
        Args: { p_job_id: string; p_org_id: string }
        Returns: Json
      }
      automation_register_failure: {
        Args: {
          p_correlation_id: string
          p_rule_id: string
          p_threshold: number
        }
        Returns: {
          attempts: number
          event_type: string
          org_id: string
          should_alert: boolean
        }[]
      }
      can_read_compensation: { Args: { target_user: string }; Returns: boolean }
      can_write_compensation: {
        Args: { target_user: string }
        Returns: boolean
      }
      cancel_stocktake_session: {
        Args: { p_org_id: string; p_reason?: string; p_session_id: string }
        Returns: string
      }
      certify_valuation: { Args: { p_valuation_id: string }; Returns: string }
      cis_derive_verification_expiry: {
        Args: { p_verified: string }
        Returns: string
      }
      cis_monthly_return_ledger_fingerprint: {
        Args: { p_org_id: string; p_tax_month_end: string }
        Returns: string
      }
      cis_return_due_date: { Args: { d: string }; Returns: string }
      cis_statement_due_date: { Args: { d: string }; Returns: string }
      cis_statement_ledger_fingerprint: {
        Args: {
          p_org_id: string
          p_supplier_id: string
          p_tax_month_end: string
        }
        Returns: string
      }
      cis_tax_month_end: { Args: { d: string }; Returns: string }
      cis_tax_month_start: { Args: { d: string }; Returns: string }
      claim_due_maintenance_reminders: {
        Args: { p_org_id: string }
        Returns: {
          due_date: string
          id: string
          job_id: string
          kind: string
          warranty_id: string
        }[]
      }
      clone_job_template: {
        Args: {
          p_anchor_date?: string
          p_job_id: string
          p_org_id: string
          p_template_id: string
        }
        Returns: string
      }
      create_blueprint_pin_with_snag: {
        Args: {
          p_blueprint_version_id: string
          p_page_number: number
          p_pin_title: string
          p_snag_description: string
          p_snag_location: string
          p_snag_priority: string
          p_snag_title: string
          p_u: number
          p_v: number
        }
        Returns: {
          assigned_to: string | null
          blueprint_version_id: string
          created_at: string
          created_by: string | null
          due_date: string | null
          id: string
          job_id: string
          kind: string
          note: string | null
          org_id: string
          page_number: number
          snag_id: string | null
          task_status: string | null
          title: string | null
          u: number
          updated_at: string
          v: number
        }
        SetofOptions: {
          from: "*"
          to: "blueprint_pins"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_org_ids: { Args: never; Returns: string[] }
      ensure_vehicle_stock_location: {
        Args: { p_name?: string; p_org_id: string; p_vehicle_asset_id: string }
        Returns: string
      }
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
      gdpr_erase_org: {
        Args: {
          p_anonymise: string[]
          p_confirm: string
          p_hard_delete: string[]
          p_org_id: string
          p_requested_by?: string
          p_retain: string[]
          p_storage_objects_deleted?: number
        }
        Returns: Json
      }
      generate_stage_invoice: {
        Args: { p_due_date?: string; p_stage_id: string }
        Returns: string
      }
      generate_valuation_invoice: {
        Args: { p_due_date?: string; p_valuation_id: string }
        Returns: string
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
      hq_ai_task_set_stage: {
        Args: { p_stage: string; p_task_id: string }
        Returns: Json
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
      hq_competitor_note_add: {
        Args: {
          p_captured_by?: string
          p_category?: string
          p_competitor_name: string
          p_detail?: string
          p_headline: string
          p_importance?: string
          p_source_url?: string
        }
        Returns: Json
      }
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
      hq_record_application: {
        Args: {
          p_action_id: string
          p_approval_id?: string
          p_approver_email?: string
          p_approver_id?: string
          p_attempts?: number
          p_correlation_id: string
          p_error?: string
          p_escalated?: boolean
          p_key: string
          p_result?: Json
          p_source: string
          p_status: string
          p_task_id?: string
          p_tool_label: string
        }
        Returns: number
      }
      hq_record_apply_audit: {
        Args: {
          p_action_id: string
          p_correlation_id: string
          p_detail: string
          p_path: string
          p_stage: string
          p_steps?: Json
          p_tool_label: string
        }
        Returns: number
      }
      hq_record_ceo_briefing: {
        Args: {
          p_briefing_date: string
          p_correlation_id?: string
          p_headline: string
          p_narrative: string
          p_signals?: Json
        }
        Returns: number
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
      inbox_channel_for_enquiry: {
        Args: { p_channel: string }
        Returns: string
      }
      is_org_admin: { Args: { target_org: string }; Returns: boolean }
      is_org_member: { Args: { target_org: string }; Returns: boolean }
      issue_cis_statement: {
        Args: {
          p_org_id: string
          p_supplier_id: string
          p_tax_month_end: string
        }
        Returns: string
      }
      issue_inspection_plan: { Args: { p_id: string }; Returns: string }
      issue_rams_revision: { Args: { p_id: string }; Returns: string }
      issue_toolbox_talk_revision: {
        Args: { p_id: string; p_snapshot: Json }
        Returns: string
      }
      mark_cis_monthly_return_exported: {
        Args: { p_org_id: string; p_return_id: string }
        Returns: undefined
      }
      marketplace_install_with_consent: {
        Args: {
          p_config?: Json
          p_consented_scopes: string[]
          p_created_by: string
          p_key_hash: string
          p_key_name: string
          p_key_prefix: string
          p_listing_id: string
          p_org_id: string
          p_webhook_secret?: string
        }
        Returns: Json
      }
      marketplace_review_listing: {
        Args: {
          p_decision: string
          p_listing_id: string
          p_notes?: string
          p_reviewer?: string
        }
        Returns: boolean
      }
      marketplace_submit_listing: {
        Args: { p_listing_id: string; p_org_id: string }
        Returns: boolean
      }
      marketplace_uninstall: {
        Args: { p_install_id: string; p_org_id: string }
        Returns: Json
      }
      material_request_fulfilment_state: {
        Args: { p_fulfilled: Json; p_org_id: string; p_request_id: string }
        Returns: string
      }
      material_request_state: {
        Args: { p_fulfilled: Json; p_request_id: string }
        Returns: string
      }
      mfa_recovery_codes_remaining: { Args: never; Returns: number }
      next_certificate_number: { Args: { target_org: string }; Returns: string }
      next_grn_number: { Args: { target_org: string }; Returns: string }
      next_invoice_number: { Args: { target_org: string }; Returns: string }
      next_material_request_number: {
        Args: { target_org: string }
        Returns: string
      }
      next_po_number: { Args: { target_org: string }; Returns: string }
      next_ptw_number: { Args: { target_org: string }; Returns: string }
      next_quote_number: { Args: { target_org: string }; Returns: string }
      next_ra_number: { Args: { target_org: string }; Returns: string }
      next_tbt_number: { Args: { target_org: string }; Returns: string }
      next_variation_number: { Args: { target_job: string }; Returns: number }
      open_stocktake_session: {
        Args: {
          p_notes?: string
          p_org_id: string
          p_reference?: string
          p_site_id: string
        }
        Returns: string
      }
      po_receipt_state: { Args: { p_po_id: string }; Returns: string }
      post_goods_received_note: {
        Args: {
          p_delivery_date: string
          p_delivery_location: string
          p_delivery_note_reference: string
          p_lines: Json
          p_notes: string
          p_org_id: string
          p_purchase_order_id: string
          p_received_by: string
        }
        Returns: string
      }
      post_stocktake_session: {
        Args: { p_org_id: string; p_session_id: string }
        Returns: number
      }
      prepare_cis_monthly_return: {
        Args: { p_org_id: string; p_tax_month_end: string }
        Returns: string
      }
      prune_cron_runs: {
        Args: {
          p_failure_days?: number
          p_max_rows?: number
          p_success_days?: number
        }
        Returns: {
          deleted_failure: number
          deleted_success: number
        }[]
      }
      publish_inspection_plan_template: {
        Args: { p_id: string }
        Returns: undefined
      }
      publish_inspection_template: {
        Args: { p_org_id: string; p_template_id: string; p_user: string }
        Returns: undefined
      }
      purchase_order_receipt_state: {
        Args: { p_org_id: string; p_po_id: string }
        Returns: string
      }
      purge_activity_log: {
        Args: { p_batch?: number; p_retention?: string }
        Returns: number
      }
      purge_weather_readings: {
        Args: { p_forecast_grace?: string; p_observation_retention?: string }
        Returns: {
          forecasts_deleted: number
          observations_deleted: number
        }[]
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
      record_cis_supplier_payment: {
        Args: {
          p_allocations: Json
          p_expected_rate?: number
          p_method: string
          p_notes: string
          p_org_id: string
          p_paid_at: string
          p_reference: string
          p_supplier_id: string
        }
        Returns: string
      }
      record_fleet_compliance_completion: {
        Args: {
          p_asset_id: string
          p_case_id: string
          p_case_type: string
          p_completed_by: string
          p_completed_on: string
          p_next_due: string
          p_odometer_miles: number
          p_org_id: string
          p_schedule_id: string
          p_supplier_id: string
          p_title: string
          p_work_performed: string
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
      record_stock_adjustment: {
        Args: {
          p_delta: number
          p_item_id: string
          p_org_id: string
          p_reason: string
          p_site_id: string
        }
        Returns: string
      }
      record_stock_correction: {
        Args: { p_movement_id: string; p_org_id: string; p_reason: string }
        Returns: string
      }
      record_stock_issue: {
        Args: {
          p_item_id: string
          p_job_id?: string
          p_material_request_line_id?: string
          p_notes?: string
          p_org_id: string
          p_qty: number
          p_site_id: string
        }
        Returns: string
      }
      record_stock_receipt_from_grn: {
        Args: {
          p_grn_line_id: string
          p_item_id: string
          p_notes?: string
          p_org_id: string
          p_site_id: string
        }
        Returns: string
      }
      record_stock_transfer: {
        Args: {
          p_from_site_id: string
          p_item_id: string
          p_notes?: string
          p_org_id: string
          p_qty: number
          p_to_site_id: string
        }
        Returns: string
      }
      record_stocktake_count: {
        Args: {
          p_counted_qty: number
          p_org_id: string
          p_session_id: string
          p_stock_item_id: string
        }
        Returns: string
      }
      record_supplier_payment: {
        Args: {
          p_allocations: Json
          p_cis_withheld: number
          p_gross_amount: number
          p_method: string
          p_notes: string
          p_org_id: string
          p_paid_at: string
          p_reference: string
          p_supplier_id: string
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
      retention_purge_run: {
        Args: {
          p_batch?: number
          p_dry_run?: boolean
          p_org_id: string
          p_policy_id?: string
          p_requested_by?: string
          p_retention_days: number
          p_target_table: string
        }
        Returns: Json
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
      save_fleet_vehicle: {
        Args: {
          p_asset_id: string
          p_created_by: string
          p_finance_agreement_ref: string
          p_finance_end_date: string
          p_finance_monthly_payment: number
          p_finance_provider_id: string
          p_finance_type: string
          p_first_registered_on: string
          p_fuel_type: string
          p_gross_weight_kg: number
          p_home_depot: string
          p_home_site_id?: string
          p_manufacturer: string
          p_model: string
          p_mot_exempt: boolean
          p_name: string
          p_notes: string
          p_odometer_miles: number
          p_operational_status: string
          p_org_id: string
          p_ownership: string
          p_purchase_date: string
          p_purchase_price: number
          p_registration: string
          p_supplier_id: string
          p_variant: string
          p_vehicle_class: string
          p_vin: string
          p_year_of_manufacture: number
        }
        Returns: string
      }
      save_job_template: {
        Args: {
          p_checklist: Json
          p_default_status: string
          p_description: string
          p_job_type: string
          p_milestones: Json
          p_name: string
          p_org_id: string
          p_template_id: string
        }
        Returns: string
      }
      set_expense_budget: {
        Args: {
          p_amount_pence: number
          p_category: string
          p_note?: string
          p_org_id: string
          p_period_type?: string
        }
        Returns: string
      }
      set_job_budget: {
        Args: {
          p_job_id: string
          p_labour_cost?: number
          p_materials_cost?: number
          p_misc_cost?: number
          p_note?: string
          p_org_id: string
          p_subcontractors_cost?: number
          p_target_margin_pct?: number
          p_total_cost: number
        }
        Returns: string
      }
      set_job_programme: {
        Args: {
          p_job_id: string
          p_milestones: Json
          p_note?: string
          p_org_id: string
          p_planned_end: string
          p_planned_start: string
        }
        Returns: string
      }
      set_milestone_dependencies: {
        Args: { p_baseline_id: string; p_edges: Json; p_org_id: string }
        Returns: number
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
      start_stocktake_counting: {
        Args: { p_org_id: string; p_session_id: string }
        Returns: string
      }
      stock_balance: {
        Args: { p_item_id: string; p_org_id: string; p_site_id: string }
        Returns: number
      }
      stock_lock_key: {
        Args: { p_item_id: string; p_site_id: string }
        Returns: number
      }
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
          p_site_id?: string
          p_vehicle_asset_id: string
        }
        Returns: string
      }
      void_goods_received_note: {
        Args: { p_grn_id: string; p_org_id: string; p_reason: string }
        Returns: string
      }
      webhook_claim_deliveries: {
        Args: { p_limit?: number }
        Returns: {
          attempt: number
          delivery_id: string
          endpoint_id: string
          event_id: number
          is_ping: boolean
          org_id: string
          payload: Json
          secret: string
          url: string
          verb: string
        }[]
      }
      webhook_dispatch_drain: { Args: { p_max_events?: number }; Returns: Json }
      webhook_enqueue_ping: {
        Args: { p_endpoint_id: string; p_org_id: string }
        Returns: string
      }
      webhook_fan_out_event: {
        Args: { p_event: Database["public"]["Tables"]["hq_events"]["Row"] }
        Returns: undefined
      }
      webhook_mark_delivered: {
        Args: {
          p_delivery_id: string
          p_sent_payload?: Json
          p_status_code: number
        }
        Returns: undefined
      }
      webhook_mark_failed: {
        Args: {
          p_dead: boolean
          p_delivery_id: string
          p_error: string
          p_failure_threshold?: number
          p_next_attempt_at: string
          p_status_code: number
        }
        Returns: undefined
      }
      webhook_redact_data: {
        Args: { p_data: Json; p_verb: string }
        Returns: Json
      }
      webhook_resolve_org: {
        Args: { p_object_id: string; p_object_type: string }
        Returns: string
      }
      withdraw_cis_statement: {
        Args: { p_org_id: string; p_reason: string; p_statement_id: string }
        Returns: undefined
      }
      works_quality_open_hold_point: {
        Args: { p_plan_id: string }
        Returns: number
      }
    }
    Enums: {
      billing_plan_structure:
        | "full"
        | "deposit_balance"
        | "staged"
        | "milestone"
        | "progress"
      billing_stage_basis: "fixed" | "percent"
      billing_stage_kind: "deposit" | "stage" | "balance"
      invoice_status:
        | "draft"
        | "sent"
        | "awaiting_payment"
        | "partially_paid"
        | "paid"
        | "overdue"
        | "void"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      billing_plan_structure: [
        "full",
        "deposit_balance",
        "staged",
        "milestone",
        "progress",
      ],
      billing_stage_basis: ["fixed", "percent"],
      billing_stage_kind: ["deposit", "stage", "balance"],
      invoice_status: [
        "draft",
        "sent",
        "awaiting_payment",
        "partially_paid",
        "paid",
        "overdue",
        "void",
      ],
    },
  },
} as const
