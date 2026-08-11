jest.mock('../../models/Complaint', () => ({
  countDocuments: jest.fn(),
  find: jest.fn(),
  aggregate: jest.fn(),
  findById: jest.fn(),
}));

const Complaint = require('../../models/Complaint');
const {
  getAllComplaints,
  updateComplaint,
} = require('../../controllers/chatbotController');

function responseMock() {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
}

describe('chatbot complaint administration authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([undefined, 'user', 'seller'])(
    'blocks %s role from listing complaints before any database query',
    async (role) => {
      const request = { user: role ? { id: 'user-1', role } : undefined, query: {} };
      const response = responseMock();

      await getAllComplaints(request, response);

      expect(response.status).toHaveBeenCalledWith(403);
      expect(response.json).toHaveBeenCalledWith({
        msg: 'Access denied. Admin privileges required.',
      });
      expect(Complaint.countDocuments).not.toHaveBeenCalled();
      expect(Complaint.find).not.toHaveBeenCalled();
      expect(Complaint.aggregate).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, 'user', 'seller'])(
    'blocks %s role from updating a complaint before any database query',
    async (role) => {
      const request = {
        user: role ? { id: 'user-1', role } : undefined,
        params: { id: 'complaint-1' },
        body: { status: 'resolved' },
      };
      const response = responseMock();

      await updateComplaint(request, response);

      expect(response.status).toHaveBeenCalledWith(403);
      expect(response.json).toHaveBeenCalledWith({
        msg: 'Access denied. Admin privileges required.',
      });
      expect(Complaint.findById).not.toHaveBeenCalled();
    },
  );

  test('allows an administrator to list complaints', async () => {
    const complaints = [{ _id: 'complaint-1' }];
    let populateCalls = 0;
    const query = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      populate: jest.fn(() => {
        populateCalls += 1;
        return populateCalls === 3 ? Promise.resolve(complaints) : query;
      }),
    };
    Complaint.countDocuments.mockResolvedValue(1);
    Complaint.find.mockReturnValue(query);
    Complaint.aggregate
      .mockResolvedValueOnce([{ _id: 'product', count: 1 }])
      .mockResolvedValueOnce([{ _id: 'open', count: 1 }]);
    const request = { user: { id: 'admin-1', role: 'admin' }, query: {} };
    const response = responseMock();

    await getAllComplaints(request, response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      complaints,
      total: 1,
      page: 1,
      totalPages: 1,
      categoryStats: { product: 1 },
      statusStats: { open: 1 },
    });
  });

  test('allows an administrator to update a complaint', async () => {
    const complaint = {
      status: 'open',
      priority: 'medium',
      adminResponse: '',
      save: jest.fn().mockResolvedValue(undefined),
    };
    Complaint.findById.mockResolvedValue(complaint);
    const request = {
      user: { id: 'admin-1', role: 'admin' },
      params: { id: 'complaint-1' },
      body: { status: 'resolved', priority: 'high', adminResponse: 'Completed' },
    };
    const response = responseMock();

    await updateComplaint(request, response);

    expect(Complaint.findById).toHaveBeenCalledWith('complaint-1');
    expect(complaint).toMatchObject({
      status: 'resolved',
      priority: 'high',
      adminResponse: 'Completed',
    });
    expect(complaint.save).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith({ msg: 'Complaint updated', complaint });
  });
});
