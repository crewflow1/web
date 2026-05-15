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
            foreignKeyName: "customers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
          scheduled_date: string | null
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
          scheduled_date?: string | null
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
          scheduled_date?: string | null
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
          first_contact_at: string
          id: string
          last_activity_at: string
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
          first_contact_at?: string
          id?: string
          last_activity_at?: string
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
          first_contact_at?: string
          id?: string
          last_activity_at?: string
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
      organizations: {
        Row: {
          address: Json | null
          country: string
          created_at: string
          email: string | null
          id: string
          logo_url: string | null
          name: string
          onboarding_state: Json
          phone: string | null
          plan: string
          slug: string
          stripe_customer_id: string | null
          timezone: string
          trial_ends_at: string | null
          updated_at: string
          vat_number: string | null
        }
        Insert: {
          address?: Json | null
          country?: string
          created_at?: string
          email?: string | null
          id?: string
          logo_url?: string | null
          name: string
          onboarding_state?: Json
          phone?: string | null
          plan?: string
          slug: string
          stripe_customer_id?: string | null
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          vat_number?: string | null
        }
        Update: {
          address?: Json | null
          country?: string
          created_at?: string
          email?: string | null
          id?: string
          logo_url?: string | null
          name?: string
          onboarding_state?: Json
          phone?: string | null
          plan?: string
          slug?: string
          stripe_customer_id?: string | null
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          vat_number?: string | null
        }
        Relationships: []
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
          created_at: string
          created_by: string | null
          currency: string
          customer_id: string
          declined_at: string | null
          id: string
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
          vat_total: number
          viewed_at: string | null
        }
        Insert: {
          accept_signature?: Json | null
          accepted_at?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_id: string
          declined_at?: string | null
          id?: string
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
          vat_total?: number
          viewed_at?: string | null
        }
        Update: {
          accept_signature?: Json | null
          accepted_at?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          customer_id?: string
          declined_at?: string | null
          id?: string
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
          vat_total?: number
          viewed_at?: string | null
        }
        Relationships: [
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
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          phone?: string | null
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
      current_org_ids: { Args: never; Returns: string[] }
      is_org_admin: { Args: { target_org: string }; Returns: boolean }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
