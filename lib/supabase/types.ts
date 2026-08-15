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
      demo_requests: {
        Row: {
          company: string
          created_at: string
          current_systems: string | null
          email: string
          employees: string | null
          id: string
          internal_lead_id: string | null
          name: string
          notes: string | null
          notification_email_id: string | null
          notification_error: string | null
          notification_sent_at: string | null
          phone: string | null
          preferred_demo_time: string | null
          source: string | null
          status: string
          turnover_range: string | null
          user_agent: string | null
        }
        Insert: {
          company: string
          created_at?: string
          current_systems?: string | null
          email: string
          employees?: string | null
          id?: string
          internal_lead_id?: string | null
          name: string
          notes?: string | null
          notification_email_id?: string | null
          notification_error?: string | null
          notification_sent_at?: string | null
          phone?: string | null
          preferred_demo_time?: string | null
          source?: string | null
          status?: string
          turnover_range?: string | null
          user_agent?: string | null
        }
        Update: {
          company?: string
          created_at?: string
          current_systems?: string | null
          email?: string
          employees?: string | null
          id?: string
          internal_lead_id?: string | null
          name?: string
          notes?: string | null
          notification_email_id?: string | null
          notification_error?: string | null
          notification_sent_at?: string | null
          phone?: string | null
          preferred_demo_time?: string | null
          source?: string | null
          status?: string
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
        Relationships: []
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
      job_checklists: {
        Row: {
          created_at: string
          created_by: string | null
          done_at: string | null
          done_by: string | null
          id: string
          is_done: boolean
          job_id: string
          label: string
          org_id: string
          requires_photo: boolean
          sort: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          done_at?: string | null
          done_by?: string | null
          id?: string
          is_done?: boolean
          job_id: string
          label: string
          org_id: string
          requires_photo?: boolean
          sort: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          done_at?: string | null
          done_by?: string | null
          id?: string
          is_done?: boolean
          job_id?: string
          label?: string
          org_id?: string
          requires_photo?: boolean
          sort?: number
        }
        Relationships: []
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
        Relationships: []
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
          created_at?: string
          customer_id?: string | null
          id?: string
          notes?: string | null
          org_id: string
          photos?: string[]
          recurring?: Json | null
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
          created_at?: string
          customer_id?: string | null
          id?: string
          notes?: string | null
          org_id?: string
          photos?: string[]
          recurring?: Json | null
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
      leads: {
        Row: {
          ai_summary: string | null
          assigned_to: string | null
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
      notifications: {
        Row: {
          action_url: string | null
          body: string | null
          created_at: string
          id: string
          org_id: string
          read_at: string | null
          related_id: string | null
          related_table: string | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          action_url?: string | null
          body?: string | null
          created_at?: string
          id?: string
          org_id: string
          read_at?: string | null
          related_id?: string | null
          related_table?: string | null
          title: string
          type: string
          user_id: string
        }
        Update: {
          action_url?: string | null
          body?: string | null
          created_at?: string
          id?: string
          org_id?: string
          read_at?: string | null
          related_id?: string | null
          related_table?: string | null
          title?: string
          type?: string
          user_id?: string
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
          bank_details: Json | null
          country: string
          created_at: string
          default_terms: string | null
          email: string | null
          id: string
          logo_path: string | null
          logo_url: string | null
          name: string
          onboarding_state: Json
          phone: string | null
          plan: string
          slug: string
          timezone: string
          trial_ends_at: string | null
          updated_at: string
          vat_number: string | null
        }
        Insert: {
          address?: Json | null
          bank_details?: Json | null
          country?: string
          created_at?: string
          default_terms?: string | null
          email?: string | null
          id?: string
          logo_path?: string | null
          logo_url?: string | null
          name: string
          onboarding_state?: Json
          phone?: string | null
          plan?: string
          slug: string
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          vat_number?: string | null
        }
        Update: {
          address?: Json | null
          bank_details?: Json | null
          country?: string
          created_at?: string
          default_terms?: string | null
          email?: string | null
          id?: string
          logo_path?: string | null
          logo_url?: string | null
          name?: string
          onboarding_state?: Json
          phone?: string | null
          plan?: string
          slug?: string
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          vat_number?: string | null
        }
        Relationships: []
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
          cost_total?: never
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
          cost_total?: never
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
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_eot_agreed_by_fkey"
            columns: ["eot_agreed_by"]
            isOneToOne: false
            referencedRelation: "users"
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
    }
    Views: {
      [_ in never]: never
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
      clone_job_template: {
        Args: {
          p_anchor_date: string | null
          p_job_id: string
          p_org_id: string
          p_template_id: string
        }
        Returns: string
      }
      current_org_ids: { Args: never; Returns: string[] }
      is_org_admin: { Args: { target_org: string }; Returns: boolean }
      is_org_member: { Args: { target_org: string }; Returns: boolean }
      mfa_recovery_codes_remaining: { Args: never; Returns: number }
      next_invoice_number: { Args: { target_org: string }; Returns: string }
      next_quote_number: { Args: { target_org: string }; Returns: string }
      next_variation_number: { Args: { target_job: string }; Returns: number }
      rate_limit_hit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: { allowed: boolean; remaining: number; reset_at: string }[]
      }
      rate_limit_sweep: { Args: never; Returns: undefined }
      remove_job_photo: {
        Args: { photo_path: string; target_job_id: string }
        Returns: undefined
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
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
  graphql_public: {
    Enums: {},
  },
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

