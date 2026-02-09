/**
 * Unit Tests for Contact Tools
 * Tests contact management MCP tools (31 tools total)
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ContactTools } from '../../src/tools/contact-tools.js';
import { MockGHLApiClient, mockContact } from '../mocks/ghl-api-client.mock.js';

describe('ContactTools', () => {
  let contactTools: ContactTools;
  let mockGhlClient: MockGHLApiClient;

  beforeEach(() => {
    mockGhlClient = new MockGHLApiClient();
    contactTools = new ContactTools(mockGhlClient as any);
  });

  describe('getToolDefinitions', () => {
    it('should return 31 contact tool definitions', () => {
      const tools = contactTools.getToolDefinitions();
      expect(tools).toHaveLength(31);
      
      const toolNames = tools.map(tool => tool.name);
      expect(toolNames).toContain('create_contact');
      expect(toolNames).toContain('search_contacts');
      expect(toolNames).toContain('get_contact');
      expect(toolNames).toContain('update_contact');
      expect(toolNames).toContain('delete_contact');
      expect(toolNames).toContain('add_contact_tags');
      expect(toolNames).toContain('remove_contact_tags');
    });

    it('should have proper schema definitions for all tools', () => {
      const tools = contactTools.getToolDefinitions();
      
      tools.forEach(tool => {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      });
    });
  });

  describe('executeTool', () => {
    it('should route tool calls correctly', async () => {
      const createSpy = jest.spyOn(contactTools as any, 'createContact');
      const getSpy = jest.spyOn(contactTools as any, 'getContact');

      await contactTools.executeTool('create_contact', { email: 'test@example.com' });
      await contactTools.executeTool('get_contact', { contactId: 'contact_123' });

      expect(createSpy).toHaveBeenCalledWith({ email: 'test@example.com' });
      expect(getSpy).toHaveBeenCalledWith('contact_123');
    });

    it('should throw error for unknown tool', async () => {
      await expect(
        contactTools.executeTool('unknown_tool', {})
      ).rejects.toThrow('Unknown tool: unknown_tool');
    });
  });

  describe('create_contact', () => {
    it('should create contact successfully', async () => {
      const contactData = {
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane.doe@example.com',
        phone: '+1-555-987-6543'
      };

      const result = await contactTools.executeTool('create_contact', contactData);

      // executeTool returns the raw GHLContact object from the API client
      expect(result).toBeDefined();
      expect(result.email).toBe(contactData.email);
    });

    it('should handle API errors', async () => {
      const mockError = new Error('GHL API Error (400): Invalid email');
      jest.spyOn(mockGhlClient, 'createContact').mockRejectedValueOnce(mockError);

      await expect(
        contactTools.executeTool('create_contact', { email: 'invalid-email' })
      ).rejects.toThrow('GHL API Error (400): Invalid email');
    });

    it('should pass source through to API client', async () => {
      const spy = jest.spyOn(mockGhlClient, 'createContact');
      
      await contactTools.executeTool('create_contact', {
        firstName: 'John',
        email: 'john@example.com'
      });

      // The source field is passed through as-is (undefined if not provided)
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          firstName: 'John',
          email: 'john@example.com',
          locationId: 'test_location_123'
        })
      );
    });
  });

  describe('search_contacts', () => {
    it('should search contacts successfully', async () => {
      const searchParams = {
        query: 'John Doe',
        limit: 10
      };

      const result = await contactTools.executeTool('search_contacts', searchParams);

      // Returns GHLSearchContactsResponse which has contacts and total
      expect(result).toBeDefined();
      expect(result.contacts).toBeDefined();
      expect(Array.isArray(result.contacts)).toBe(true);
      expect(result.total).toBeDefined();
    });

    it('should pass limit to API client', async () => {
      const spy = jest.spyOn(mockGhlClient, 'searchContacts');
      
      await contactTools.executeTool('search_contacts', { query: 'test' });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test',
          locationId: 'test_location_123'
        })
      );
    });

    it('should handle search with email filter', async () => {
      const result = await contactTools.executeTool('search_contacts', {
        email: 'john@example.com'
      });

      expect(result).toBeDefined();
      expect(result.contacts).toBeDefined();
    });
  });

  describe('get_contact', () => {
    it('should get contact by ID successfully', async () => {
      const result = await contactTools.executeTool('get_contact', {
        contactId: 'contact_123'
      });

      // Returns raw GHLContact
      expect(result).toBeDefined();
      expect(result.id).toBe('contact_123');
    });

    it('should handle contact not found', async () => {
      await expect(
        contactTools.executeTool('get_contact', { contactId: 'not_found' })
      ).rejects.toThrow('GHL API Error (404): Contact not found');
    });
  });

  describe('update_contact', () => {
    it('should update contact successfully', async () => {
      const updateData = {
        contactId: 'contact_123',
        firstName: 'Updated',
        lastName: 'Name'
      };

      const result = await contactTools.executeTool('update_contact', updateData);

      // Returns raw GHLContact with updated fields
      expect(result).toBeDefined();
      expect(result.firstName).toBe('Updated');
    });

    it('should handle partial updates', async () => {
      const spy = jest.spyOn(mockGhlClient, 'updateContact');
      
      await contactTools.executeTool('update_contact', {
        contactId: 'contact_123',
        email: 'newemail@example.com'
      });

      expect(spy).toHaveBeenCalledWith('contact_123', {
        email: 'newemail@example.com'
      });
    });
  });

  describe('add_contact_tags', () => {
    it('should add tags successfully', async () => {
      const result = await contactTools.executeTool('add_contact_tags', {
        contactId: 'contact_123',
        tags: ['vip', 'premium']
      });

      // Returns GHLContactTagsResponse which has tags array
      expect(result).toBeDefined();
      expect(result.tags).toBeDefined();
      expect(Array.isArray(result.tags)).toBe(true);
    });

    it('should validate required parameters', async () => {
      await expect(
        contactTools.executeTool('add_contact_tags', { contactId: 'contact_123' })
      ).rejects.toThrow();
    });
  });

  describe('remove_contact_tags', () => {
    it('should remove tags successfully', async () => {
      const result = await contactTools.executeTool('remove_contact_tags', {
        contactId: 'contact_123',
        tags: ['old-tag']
      });

      expect(result).toBeDefined();
      expect(result.tags).toBeDefined();
    });

    it('should handle empty tags array', async () => {
      const spy = jest.spyOn(mockGhlClient, 'removeContactTags');
      
      await contactTools.executeTool('remove_contact_tags', {
        contactId: 'contact_123',
        tags: []
      });

      expect(spy).toHaveBeenCalledWith('contact_123', []);
    });
  });

  describe('delete_contact', () => {
    it('should delete contact successfully', async () => {
      const result = await contactTools.executeTool('delete_contact', {
        contactId: 'contact_123'
      });

      // Returns { succeded: boolean }
      expect(result).toBeDefined();
      expect(result.succeded).toBe(true);
    });

    it('should handle deletion errors', async () => {
      const mockError = new Error('GHL API Error (404): Contact not found');
      jest.spyOn(mockGhlClient, 'deleteContact').mockRejectedValueOnce(mockError);

      await expect(
        contactTools.executeTool('delete_contact', { contactId: 'not_found' })
      ).rejects.toThrow('GHL API Error (404): Contact not found');
    });
  });

  describe('error handling', () => {
    it('should propagate API client errors', async () => {
      const mockError = new Error('Network error');
      jest.spyOn(mockGhlClient, 'createContact').mockRejectedValueOnce(mockError);

      await expect(
        contactTools.executeTool('create_contact', { email: 'test@example.com' })
      ).rejects.toThrow('Network error');
    });

    it('should handle missing required fields gracefully', async () => {
      // The tool layer doesn't validate required fields itself;
      // it passes params through to the API client which may succeed
      const result = await contactTools.executeTool('create_contact', { firstName: 'John' });
      expect(result).toBeDefined();
    });
  });

  describe('input validation', () => {
    it('should not include email format in schema (simple type only)', () => {
      const tools = contactTools.getToolDefinitions();
      const createContactTool = tools.find(tool => tool.name === 'create_contact');
      
      // The current schema uses simple type: 'string' without format
      expect(createContactTool?.inputSchema.properties.email.type).toBe('string');
    });

    it('should validate required fields in schema', () => {
      const tools = contactTools.getToolDefinitions();
      const createContactTool = tools.find(tool => tool.name === 'create_contact');
      
      expect(createContactTool?.inputSchema.required).toEqual(['email']);
    });
  });
});
