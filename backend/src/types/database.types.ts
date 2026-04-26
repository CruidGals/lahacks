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
      bounties: {
        Row: {
          claimed_at: string | null
          claimer_id: string | null
          created_at: string | null
          description: string | null
          difficulty_score: number | null
          escrow_tx_sig: string | null
          id: string
          importance_score: number | null
          lat: number
          lng: number
          poster_id: string | null
          reference_video_url: string | null
          reward_lamports: number
          reward_type: Database["public"]["Enums"]["reward_type"]
          reward_xp: number | null
          status: Database["public"]["Enums"]["bounty_status"] | null
          title: string | null
          xp_award: number
          xp_reasoning: string | null
        }
        Insert: {
          claimed_at?: string | null
          claimer_id?: string | null
          created_at?: string | null
          description?: string | null
          difficulty_score?: number | null
          escrow_tx_sig?: string | null
          id?: string
          importance_score?: number | null
          lat: number
          lng: number
          poster_id?: string | null
          reference_video_url?: string | null
          reward_lamports?: number
          reward_type?: Database["public"]["Enums"]["reward_type"]
          reward_xp?: number | null
          status?: Database["public"]["Enums"]["bounty_status"] | null
          title?: string | null
          xp_award?: number
          xp_reasoning?: string | null
        }
        Update: {
          claimed_at?: string | null
          claimer_id?: string | null
          created_at?: string | null
          description?: string | null
          difficulty_score?: number | null
          escrow_tx_sig?: string | null
          id?: string
          importance_score?: number | null
          lat?: number
          lng?: number
          poster_id?: string | null
          reference_video_url?: string | null
          reward_lamports?: number
          reward_type?: Database["public"]["Enums"]["reward_type"]
          reward_xp?: number | null
          status?: Database["public"]["Enums"]["bounty_status"] | null
          title?: string | null
          xp_award?: number
          xp_reasoning?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bounties_claimer_id_fkey"
            columns: ["claimer_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bounties_poster_id_fkey"
            columns: ["poster_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      cleanups: {
        Row: {
          bounty_id: string | null
          confidence_score: number | null
          id: string
          payout_tx_sig: string | null
          session_id: string | null
          status: Database["public"]["Enums"]["cleanup_status"] | null
          verification_result: Json | null
          video_url: string | null
        }
        Insert: {
          bounty_id?: string | null
          confidence_score?: number | null
          id?: string
          payout_tx_sig?: string | null
          session_id?: string | null
          status?: Database["public"]["Enums"]["cleanup_status"] | null
          verification_result?: Json | null
          video_url?: string | null
        }
        Update: {
          bounty_id?: string | null
          confidence_score?: number | null
          id?: string
          payout_tx_sig?: string | null
          session_id?: string | null
          status?: Database["public"]["Enums"]["cleanup_status"] | null
          verification_result?: Json | null
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cleanups_bounty_id_fkey"
            columns: ["bounty_id"]
            isOneToOne: false
            referencedRelation: "bounties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cleanups_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      gps_pings: {
        Row: {
          accuracy: number | null
          id: string
          lat: number
          lng: number
          session_id: string | null
          timestamp: string | null
        }
        Insert: {
          accuracy?: number | null
          id?: string
          lat: number
          lng: number
          session_id?: string | null
          timestamp?: string | null
        }
        Update: {
          accuracy?: number | null
          id?: string
          lat?: number
          lng?: number
          session_id?: string | null
          timestamp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gps_pings_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          bounty_id: string | null
          ended_at: string | null
          id: string
          nonce: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["session_status"] | null
          user_id: string | null
        }
        Insert: {
          bounty_id?: string | null
          ended_at?: string | null
          id?: string
          nonce?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["session_status"] | null
          user_id?: string | null
        }
        Update: {
          bounty_id?: string | null
          ended_at?: string | null
          id?: string
          nonce?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["session_status"] | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sessions_bounty_id_fkey"
            columns: ["bounty_id"]
            isOneToOne: false
            referencedRelation: "bounties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string | null
          display_name: string | null
          id: string
          total_earned_lamports: number
          total_earned_xp: number
          verified: boolean | null
          wallet_address: string
          world_id_hash: string | null
          xp: number
        }
        Insert: {
          created_at?: string | null
          display_name?: string | null
          id?: string
          total_earned_lamports?: number
          total_earned_xp?: number
          verified?: boolean | null
          wallet_address: string
          world_id_hash?: string | null
          xp?: number
        }
        Update: {
          created_at?: string | null
          display_name?: string | null
          id?: string
          total_earned_lamports?: number
          total_earned_xp?: number
          verified?: boolean | null
          wallet_address?: string
          world_id_hash?: string | null
          xp?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_earned_lamports: {
        Args: { p_user_id: string; p_lamports: number }
        Returns: number
      }
      award_xp: {
        Args: { p_user_id: string; p_amount: number }
        Returns: number
      }
      refund_xp: {
        Args: { p_user_id: string; p_amount: number }
        Returns: number
      }
      stake_xp: {
        Args: { p_user_id: string; p_amount: number }
        Returns: number
      }
    }
    Enums: {
      bounty_status: "open" | "claimed" | "completed" | "expired"
      cleanup_status: "pending" | "verified" | "rejected"
      reward_type: "sol" | "xp"
      session_status: "active" | "completed" | "cancelled"
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
      bounty_status: ["open", "claimed", "completed", "expired"],
      cleanup_status: ["pending", "verified", "rejected"],
      reward_type: ["sol", "xp"],
      session_status: ["active", "completed", "cancelled"],
    },
  },
} as const
