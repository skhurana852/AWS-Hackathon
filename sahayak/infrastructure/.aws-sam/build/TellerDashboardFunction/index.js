/**
 * Teller Dashboard Lambda — GET /dashboard/tasks
 * Returns pending hand-off tasks for the teller UI.
 * Also supports PATCH /dashboard/tasks/{taskId} to update task status.
 */
const {
  ddb, TABLE, ok, badReq, err500,
  ScanCommand, UpdateCommand, GetCommand
} = require("./utils");

exports.handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method || "GET";

  if (method === "GET") return listTasks(event);
  if (method === "PATCH") return updateTask(event);

  return badReq("Unsupported method.");
};

const listTasks = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const status = qs.status || "PENDING";

    const result = await ddb.send(new ScanCommand({
      TableName: TABLE.TASKS,
      FilterExpression: "#s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status }
    }));

    const tasks = (result.Items || []).sort((a, b) => b.createdAt - a.createdAt);

    return ok({
      tasks,
      count: tasks.length,
      fetchedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error("list tasks error:", e);
    return err500("Unable to fetch tasks.");
  }
};

const updateTask = async (event) => {
  try {
    const { taskId } = event.pathParameters || {};
    if (!taskId) return badReq("taskId path parameter required.");

    const body = JSON.parse(event.body || "{}");
    const { status, tellerNote, tellerName } = body;

    const validStatuses = ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
    if (!status || !validStatuses.includes(status)) {
      return badReq(`status must be one of: ${validStatuses.join(", ")}`);
    }

    await ddb.send(new UpdateCommand({
      TableName: TABLE.TASKS,
      Key: { taskId },
      UpdateExpression: "SET #s = :s, updatedAt = :t, tellerNote = :n, tellerName = :tn",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": status,
        ":t": Date.now(),
        ":n": tellerNote || "",
        ":tn": tellerName || "Teller"
      }
    }));

    return ok({ taskId, status, message: "Task updated." });
  } catch (e) {
    console.error("update task error:", e);
    return err500("Unable to update task.");
  }
};
