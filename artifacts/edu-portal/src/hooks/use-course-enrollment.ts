import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  enrollInCourse,
  listEnrollments,
  getListEnrollmentsQueryKey,
  getListCoursesQueryKey,
  getGetCourseQueryKey,
  type Enrollment,
} from "@workspace/api-client-react";

class EnrollmentUnconfirmedError extends Error {
  constructor() {
    super("We couldn't confirm your enrollment. Please check your connection and try again; an existing enrollment will be reused.");
  }
}

function errorStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status : undefined;
}

export function enrollmentErrorNotice(error: unknown) {
  const status = errorStatus(error);
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  const serverMessage = data && typeof data === "object" && "error" in data && typeof data.error === "string"
    ? data.error : undefined;
  return {
    title: error instanceof EnrollmentUnconfirmedError ? "Enrollment not confirmed"
      : status === 403 ? "Membership upgrade required"
      : status === 401 ? "Sign in required" : "Enrollment failed",
    description: serverMessage ?? (error instanceof Error ? error.message : "Please try again."),
    variant: "destructive" as const,
  };
}

export function useCourseEnrollment(onEnrolled: (enrollment: Enrollment) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async ({ data }: { data: { courseId: number } }) => {
      try {
        return await enrollInCourse(data);
      } catch (error) {
        const status = errorStatus(error);
        // Access/validation rejections are definitive; a timeout or server error
        // may occur after the enrollment committed.
        if (status && status >= 400 && status < 500 && status !== 408) throw error;
        let persisted: Enrollment[];
        try {
          // Bypass cached data and in-flight pre-enrollment queries.
          persisted = await listEnrollments();
        } catch {
          throw new EnrollmentUnconfirmedError();
        }
        await queryClient.cancelQueries({ queryKey: getListEnrollmentsQueryKey() });
        queryClient.setQueryData(getListEnrollmentsQueryKey(), persisted);
        const enrollment = persisted.find(item => item.courseId === data.courseId);
        if (enrollment) return enrollment;
        throw new Error("Your enrollment wasn't found. Please try again.");
      }
    },
    onSuccess: async (enrollment) => {
      await queryClient.cancelQueries({ queryKey: getListEnrollmentsQueryKey() });
      queryClient.setQueryData<Enrollment[]>(getListEnrollmentsQueryKey(), previous => [
        ...(previous ?? []).filter(item => item.courseId !== enrollment.courseId),
        enrollment,
      ]);
      void queryClient.invalidateQueries({ queryKey: getListEnrollmentsQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListCoursesQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getGetCourseQueryKey(enrollment.courseId) });
      onEnrolled(enrollment);
    },
  });
}